// The vanish effect, drawn with WebGL2.
//
// Every frame, five passes:
//   1. person  the segmenter's mask, widened a little, plus discs over the hand
//              landmarks: the segmenter was trained on head-and-shoulders
//              footage and can miss a raised hand.                    R8
//      recent  where you have been lately: the person mask, kept as a running
//              maximum that fades with a 250 ms half-life. The room is only
//              learned where this is near zero, so a spot has to be clear of
//              you for about a second. Without it, every frame the cutout was
//              unsure about let a little of you into the room, and vanishing
//              left a smeared copy of you behind.                     R8
//   2. room    the camera blended into a texture wherever nobody has been,
//              10% a frame. Colour and alpha grow together from zero, so the
//              result is premultiplied and its mipmaps average only what was
//              seen. Half-float: in 8 bits, 10% steps stall short of the target.
//   3. stats   live and room brightness over the visible background, mipmapped
//              down to one pixel, so the hidden patch can follow the camera's
//              auto-exposure. No read-back to the CPU.
//   4. screen  the live picture. While the effect runs: the room wherever the
//              live mask sees you, and the snapshot of you frozen at the snap,
//              eaten away in patches of noise.
//   5. specks  one GL point per 4×4 pixels of you, each placed by a formula of
//              time: no vertex buffers, no simulation, nothing to carry between
//              frames. Played backwards, the same formula brings you back, onto
//              a snapshot retaken every frame so it lands where you are.
//
// Textures keep image rows top-down (row 0 at t = 0). Only the screen passes
// flip: vertically for the canvas, and horizontally to mirror. Mirroring here
// rather than in CSS means a recording looks like what you saw.

const PERSON_W = 320;
const ROOM_W = 640;
const STATS_W = 64;
// The guess for the room you've always covered is made at this width: it is a
// smooth guess either way, and it keeps the row search cheap.
const FILL_W = 160;
const FROZEN_MAX_W = 1280;
const SPECK_COLS = 320;
const ROOM_RATE = 0.1;
// "Capture the room" learns faster, but still only where you aren't.
const CAPTURE_RATE = 0.3;
const RECENT_HALF_LIFE_MS = 250;
// How far the person mask is widened, in mask pixels (3 of 256 ≈ 15 px of 1280).
const GROW_TEXELS = 3;
// Each speck's flight, as a share of the effect's clock.
const LIFE = 0.4;
// How far a speck drifts at the end of its flight, in frame heights, at speed 1.
const DRIFT = 0.45;

const PHASES = { idle: 0, dissolving: 1, gone: 2, returning: 3 };

// Hand bones, for the discs in pass 1.
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const MAX_DISCS = 96;

// A triangle that covers the screen, from gl_VertexID alone. vTex runs 0..1
// over the target, so a texture-to-texture pass copies row for row.
const FULLSCREEN_VS = `#version 300 es
out vec2 vTex;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vTex = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Shared by the screen and the specks, so the hole in the snapshot and the
// speck that leaves it start at the same moment.
const NOISE = `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int k = 0; k < 4; k++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}
// When this spot starts to go, on the effect's 0..1 clock: patches of noise,
// the downwind side a little sooner. Ends by 1 - life so every speck lands.
float delayAt(vec2 t, vec2 wind, float aspect, float life) {
  float n = clamp((fbm(t * vec2(aspect, 1.0) * 5.0) - 0.2) / 0.6, 0.0, 1.0);
  float sweep = clamp(0.5 + dot(wind, (t - 0.5) * vec2(aspect, 1.0)) * 0.6, 0.0, 1.0);
  return (0.7 * n + 0.3 * (1.0 - sweep)) * (1.0 - life);
}
`;

const PERSON_FS = `#version 300 es
precision highp float;
in vec2 vTex;
uniform sampler2D uMask;
uniform vec2 uStep;
out vec4 o;
void main() {
  float m = texture(uMask, vTex).r;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982;
    m = max(m, texture(uMask, vTex + vec2(cos(a), sin(a)) * uStep).r);
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

const DISC_VS = `#version 300 es
uniform vec2 uDiscs[${MAX_DISCS}];
uniform float uRadius;
void main() {
  gl_Position = vec4(uDiscs[gl_VertexID] * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uRadius * 2.0;
}`;

const DISC_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  o = vec4(1.0, 0.0, 0.0, 1.0);
}`;

// Multiplies what is there by uKeep (blendFunc ZERO, SRC_ALPHA): the fade
// half of the running maximum.
const FADE_FS = `#version 300 es
precision mediump float;
uniform float uKeep;
out vec4 o;
void main() { o = vec4(0.0, 0.0, 0.0, uKeep); }`;

const ROOM_FS = `#version 300 es
precision highp float;
in vec2 vTex;
uniform sampler2D uVideo;
uniform sampler2D uRecent;
uniform float uRate;
out vec4 o;
void main() {
  // Even a faint, recent "you" here keeps it out of the room.
  float clear = 1.0 - smoothstep(0.05, 0.25, texture(uRecent, vTex).r);
  o = vec4(texture(uVideo, vTex).rgb, uRate * clear);
}`;

const STATS_FS = `#version 300 es
precision highp float;
in vec2 vTex;
uniform sampler2D uVideo;
uniform sampler2D uPerson;
uniform sampler2D uRoom;
out vec4 o;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  vec4 room = textureLod(uRoom, vTex, 2.0);
  float w = (1.0 - smoothstep(0.05, 0.3, texture(uPerson, vTex).r)) * step(0.9, room.a);
  float live = dot(texture(uVideo, vTex).rgb, LUMA);
  float seen = dot(room.rgb / max(room.a, 1e-3), LUMA);
  o = vec4(live * w, seen * w, w, 1.0);
}`;

// The part of the room never seen, usually right behind you, continued along
// each row from the nearest seen room on the left and the right, weighted by
// distance. A wall stays the wall's colour and a sofa edge stays a straight
// line. The earlier fill averaged every direction, which mixed wall and sofa
// into a grey silhouette of you: in a drawn test room, 14.5 out of 255 off the
// real background on average. Rows with nothing seen on either side fall back
// to that average ("pull-push": finest mip level first, then coarser).
const FILL_FS = `#version 300 es
precision highp float;
in vec2 vTex;
uniform sampler2D uRoom;
uniform float uLod;
uniform float uStep;
uniform int uSteps;
uniform float uRoomLevels;
out vec4 o;
const float SEEN = 0.6;
vec3 pullPush(vec2 t) {
  vec4 acc = vec4(0.0);
  for (int l = 0; l < 12; l++) {
    if (float(l) > uRoomLevels) break;
    acc += textureLod(uRoom, t, float(l)) * (1.0 - acc.a);
    if (acc.a > 0.995) break;
  }
  return acc.a > 0.001 ? acc.rgb / acc.a : vec3(0.0);
}
void main() {
  vec4 here = textureLod(uRoom, vTex, uLod);
  if (here.a >= SEEN) { o = vec4(here.rgb / here.a, 1.0); return; }
  vec3 left = vec3(0.0);
  vec3 right = vec3(0.0);
  float dl = -1.0;
  float dr = -1.0;
  for (int k = 1; k <= 256; k++) {
    if (k > uSteps || (dl >= 0.0 && dr >= 0.0)) break;
    float dx = float(k) * uStep;
    if (dl < 0.0 && vTex.x - dx >= 0.0) {
      vec4 s = textureLod(uRoom, vec2(vTex.x - dx, vTex.y), uLod);
      if (s.a >= SEEN) { left = s.rgb / s.a; dl = dx; }
    }
    if (dr < 0.0 && vTex.x + dx <= 1.0) {
      vec4 s = textureLod(uRoom, vec2(vTex.x + dx, vTex.y), uLod);
      if (s.a >= SEEN) { right = s.rgb / s.a; dr = dx; }
    }
  }
  vec3 c;
  if (dl >= 0.0 && dr >= 0.0) c = mix(left, right, dl / (dl + dr));
  else if (dl >= 0.0) c = left;
  else if (dr >= 0.0) c = right;
  else c = pullPush(vTex);
  o = vec4(c, 1.0);
}`;

const SCREEN_FS = `#version 300 es
precision highp float;
in vec2 vTex;
uniform sampler2D uVideo;
uniform sampler2D uPerson;
uniform sampler2D uPersonNow;
uniform sampler2D uRoom;
uniform sampler2D uFill;
uniform sampler2D uStats;
uniform sampler2D uFrozen;
uniform sampler2D uFrozenMask;
uniform int uPhase;
uniform float uT;
uniform float uAsh;
uniform float uLife;
uniform float uAspect;
uniform float uReduced;
uniform float uStatsLevel;
uniform vec2 uWind;
out vec4 o;
const vec3 ASH = vec3(0.227, 0.2, 0.188);
${NOISE}
// The room as seen where it has been seen (sharp), and the row-by-row guess
// where it hasn't, with a soft hand-over between the two.
vec3 roomAt(vec2 t) {
  vec4 seen = textureLod(uRoom, t, 0.0);
  float sure = smoothstep(0.4, 0.8, seen.a);
  return mix(texture(uFill, t).rgb, seen.rgb / max(seen.a, 1e-3), sure);
}
void main() {
  vec2 t = vec2(1.0 - vTex.x, 1.0 - vTex.y);
  vec3 live = texture(uVideo, t).rgb;
  if (uPhase == 0) { o = vec4(live, 1.0); return; }

  vec4 s = textureLod(uStats, vec2(0.5), uStatsLevel);
  float gain = (s.b > 0.002 && s.g > 0.002) ? clamp(s.r / s.g, 0.7, 1.4) : 1.0;
  // Hidden: wherever you are this frame, and, where the room behind is known,
  // wherever you were in the last second too, so an unsure frame from the
  // cutout can't let you flicker back. Where the room isn't known, the spot
  // you just left shows live: the camera sees the real wall there now, which
  // beats a guess smeared along behind you.
  float known = smoothstep(0.5, 0.9, textureLod(uRoom, t, 0.0).a);
  float hide = max(
    smoothstep(0.3, 0.6, texture(uPersonNow, t).r),
    smoothstep(0.15, 0.4, texture(uPerson, t).r) * known
  );
  vec3 base = mix(live, roomAt(t) * gain, hide);

  vec3 statue = texture(uFrozen, t).rgb;
  float you = smoothstep(0.35, 0.65, texture(uFrozenMask, t).r);
  float shown;
  if (uReduced > 0.5) {
    shown = 1.0 - uT;
  } else {
    float d = delayAt(t, uWind, uAspect, uLife);
    shown = smoothstep(uT, uT + 0.01, d);
    // Just before a spot goes, it darkens toward ash: the burning edge.
    float edge = 1.0 - smoothstep(0.0, 0.035, d - uT);
    statue = mix(statue, ASH * 1.4, edge * uAsh * step(0.001, uT));
  }
  o = vec4(mix(base, statue, you * shown), 1.0);
}`;

const SPECK_VS = `#version 300 es
precision highp float;
uniform sampler2D uFrozen;
uniform sampler2D uFrozenMask;
uniform ivec2 uGrid;
uniform float uT;
uniform float uLife;
uniform float uAspect;
uniform float uSpeed;
uniform float uSize;
uniform float uAsh;
uniform vec2 uWind;
out vec4 vColor;
const vec3 ASH = vec3(0.227, 0.2, 0.188);
${NOISE}
void main() {
  ivec2 cell = ivec2(gl_VertexID % uGrid.x, gl_VertexID / uGrid.x);
  vec2 t = (vec2(cell) + 0.5) / vec2(uGrid);
  float you = textureLod(uFrozenMask, t, 0.0).r;
  float age = (uT - delayAt(t, uWind, uAspect, uLife)) / uLife;
  if (you < 0.5 || age <= 0.0 || age >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    vColor = vec4(0.0);
    return;
  }
  float r1 = hash(t * 917.0 + 3.1);
  float r2 = hash(t * 331.0 + 7.7);
  vec2 drift = uWind * uSpeed * (0.6 + 0.8 * r1) * pow(age, 1.4);
  vec2 swirl = vec2(sin(age * 9.0 + r1 * 6.2832), cos(age * 7.0 + r2 * 6.2832)) * 0.03 * age;
  vec2 p = t + (drift + swirl) * vec2(1.0 / uAspect, 1.0);
  gl_Position = vec4(1.0 - 2.0 * p.x, 1.0 - 2.0 * p.y, 0.0, 1.0);
  gl_PointSize = max(1.0, uSize * (1.0 - 0.55 * age));
  vec3 c = textureLod(uFrozen, t, 0.0).rgb;
  vColor = vec4(mix(c, ASH, smoothstep(0.0, 0.45, age) * uAsh), 1.0 - smoothstep(0.55, 1.0, age));
}`;

const SPECK_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 o;
void main() {
  float a = vColor.a * (1.0 - smoothstep(0.3, 0.5, length(gl_PointCoord - 0.5)));
  if (a < 0.01) discard;
  o = vec4(vColor.rgb, a);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 vTex;
uniform sampler2D uSrc;
out vec4 o;
void main() { o = texture(uSrc, vTex); }`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader did not compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`shaders did not link: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let k = 0; k < count; k += 1) {
    const name = gl.getActiveUniform(p, k).name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

const levelsFor = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1;

export class VanishRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('this browser has no WebGL2');
    this.gl = gl;
    this.canvas = canvas;
    // Rendering into half-float textures needs this. Without it the room
    // falls back to 8 bits and simply follows slow light changes less well.
    this.floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'));

    this.prog = {
      person: program(gl, FULLSCREEN_VS, PERSON_FS),
      disc: program(gl, DISC_VS, DISC_FS),
      fade: program(gl, FULLSCREEN_VS, FADE_FS),
      room: program(gl, FULLSCREEN_VS, ROOM_FS),
      stats: program(gl, FULLSCREEN_VS, STATS_FS),
      fill: program(gl, FULLSCREEN_VS, FILL_FS),
      screen: program(gl, FULLSCREEN_VS, SCREEN_FS),
      speck: program(gl, SPECK_VS, SPECK_FS),
      copy: program(gl, FULLSCREEN_VS, COPY_FS),
    };
    // Every pass makes its vertices from gl_VertexID, but WebGL2 still wants a
    // vertex array bound to draw.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.videoTex = this.#texture({ filter: gl.LINEAR });
    this.maskTex = this.#texture({ filter: gl.LINEAR });
    this.hasMask = false;
    this.discs = new Float32Array(MAX_DISCS * 2);
    this.discCount = 0;
    this.discRadius = 0;
    this.size = null;
  }

  /** Room and snapshot sizes follow the video's shape; set on its first frame. */
  #allocate(vw, vh) {
    const gl = this.gl;
    const aspect = vw / vh;
    const dims = (w) => [w, Math.max(1, Math.round(w / aspect))];
    const [pw, ph] = dims(PERSON_W);
    const [rw, rh] = dims(ROOM_W);
    const [sw, sh] = dims(STATS_W);
    const [fw, fh] = dims(Math.min(vw, FROZEN_MAX_W));
    const roomFormat = this.floatTargets ? gl.RGBA16F : gl.RGBA8;

    this.size = { vw, vh, aspect, pw, ph, rw, rh, sw, sh, fw, fh, gridX: SPECK_COLS, gridY: dims(SPECK_COLS)[1] };
    this.person = this.#target(pw, ph, gl.R8);
    this.recent = this.#target(pw, ph, gl.R8);
    this.room = this.#target(rw, rh, roomFormat, levelsFor(rw, rh));
    this.stats = this.#target(sw, sh, roomFormat, levelsFor(sw, sh));
    this.fill = this.#target(FILL_W, dims(FILL_W)[1], gl.RGBA8);
    this.frozen = this.#target(fw, fh, gl.RGBA8);
    this.frozenMask = this.#target(pw, ph, gl.R8);
    this.roomLevels = levelsFor(rw, rh) - 1;
    this.statsLevel = levelsFor(sw, sh) - 1;
    this.lastRenderAt = null;
    this.resetRoom();
  }

  /** Forget the room: "Capture the room" starts from nothing, not from a room that may hold you. */
  resetRoom() {
    if (!this.size) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    for (const target of [this.room, this.recent]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  #texture({ filter }) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** A texture to render into, with its framebuffer. Mipmapped when levels > 1. */
  #target(w, h, format, levels = 1) {
    const gl = this.gl;
    const tex = this.#texture({ filter: levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR });
    gl.texStorage2D(gl.TEXTURE_2D, levels, format, w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`cannot render into a ${w}×${h} texture (0x${status.toString(16)})`);
    return { tex, fb, w, h };
  }

  /** The canvas's pixel size: its laid-out width, in device pixels, at the video's shape. */
  resize() {
    if (!this.size) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(1920, Math.max(2, Math.round(this.canvas.clientWidth * dpr)));
    const h = Math.round(w / this.size.aspect);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** The segmenter's person confidence, row-major from the top. */
  setMask(mask) {
    if (!mask) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, mask.width, mask.height, 0, gl.RED, gl.FLOAT, mask.data);
    this.maskStep = [GROW_TEXELS / mask.width, GROW_TEXELS / mask.height];
    this.hasMask = true;
  }

  /** Raw MediaPipe hand landmarks (0–1 of the video), or null. */
  setHand(landmarks) {
    this.discCount = 0;
    if (!landmarks?.length || !this.size) return;
    const put = (x, y) => {
      if (this.discCount >= MAX_DISCS) return;
      this.discs[this.discCount * 2] = x;
      this.discs[this.discCount * 2 + 1] = y;
      this.discCount += 1;
    };
    for (const p of landmarks) put(p.x, p.y);
    for (const [a, b] of BONES) {
      for (const f of [0.25, 0.5, 0.75]) {
        put(landmarks[a].x + (landmarks[b].x - landmarks[a].x) * f, landmarks[a].y + (landmarks[b].y - landmarks[a].y) * f);
      }
    }
    const palm = Math.hypot(
      (landmarks[9].x - landmarks[0].x) * this.size.pw,
      (landmarks[9].y - landmarks[0].y) * this.size.ph,
    );
    this.discRadius = Math.max(2, palm * 0.35);
  }

  #bind(unit, tex, location) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(location, unit);
  }

  #pass(target, prog) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    if (target) gl.viewport(0, 0, target.w, target.h);
    else gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(prog.p);
    return prog.u;
  }

  #copy(src, target) {
    const u = this.#pass(target, this.prog.copy);
    this.#bind(0, src, u.uSrc);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /**
   * Draw one frame.
   *
   * @param {HTMLVideoElement} video
   * @param {object} frame
   * @param {string} frame.phase From VanishTimeline.
   * @param {number} frame.t The effect's clock, 0–1.
   * @param {boolean} [frame.freeze] Take the snapshot of you now (a phase began).
   * @param {boolean} [frame.capture] "Capture the room": learn it faster.
   * @param {boolean} [frame.reduced] Reduce motion: a fade, no specks.
   * @param {object} frame.dust dustSettings(), plus `wind` from windInTexture().
   * @param {number} [frame.now] For the fading memory of where you were.
   */
  render(video, { phase, t, freeze = false, capture = false, reduced = false, dust, now = performance.now() }) {
    const gl = this.gl;
    if (!video.videoWidth || video.readyState < 2) return false;
    if (!this.size || this.size.vw !== video.videoWidth || this.size.vh !== video.videoHeight) {
      this.#allocate(video.videoWidth, video.videoHeight);
    }
    this.resize();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    // 1. Where you are: the widened mask, then the hand on top.
    let u = this.#pass(this.person, this.prog.person);
    if (this.hasMask) {
      this.#bind(0, this.maskTex, u.uMask);
      gl.uniform2f(u.uStep, this.maskStep[0], this.maskStep[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (this.discCount > 0) {
      u = this.#pass(this.person, this.prog.disc);
      gl.uniform2fv(u.uDiscs, this.discs);
      gl.uniform1f(u.uRadius, this.discRadius);
      gl.drawArrays(gl.POINTS, 0, this.discCount);
    }

    // Where you've been lately: fade the memory, then take the larger of it and
    // where you are now. Blending does both, so there's no second texture.
    const dt = this.lastRenderAt === null ? 0 : Math.max(0, now - this.lastRenderAt);
    this.lastRenderAt = now;
    u = this.#pass(this.recent, this.prog.fade);
    gl.uniform1f(u.uKeep, 0.5 ** (dt / RECENT_HALF_LIFE_MS));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    u = this.#pass(this.recent, this.prog.copy);
    this.#bind(0, this.person.tex, u.uSrc);
    gl.blendEquation(gl.MAX);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);

    // 2. Learn the room wherever you haven't been.
    u = this.#pass(this.room, this.prog.room);
    this.#bind(0, this.videoTex, u.uVideo);
    this.#bind(1, this.recent.tex, u.uRecent);
    gl.uniform1f(u.uRate, capture ? CAPTURE_RATE : ROOM_RATE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);

    // Dissolving keeps the snapshot from the moment of the snap. Coming back
    // retakes it every frame, so the dust lands where you are now: a snapshot
    // from when the return began left a second you behind if you had moved.
    if (freeze || phase === 'returning') {
      this.#copy(this.videoTex, this.frozen);
      this.#copy(this.person.tex, this.frozenMask);
    }

    const active = phase !== 'idle';
    if (active) {
      gl.bindTexture(gl.TEXTURE_2D, this.room.tex);
      gl.generateMipmap(gl.TEXTURE_2D);

      // 3. How bright the background is now, against the learned room.
      u = this.#pass(this.stats, this.prog.stats);
      this.#bind(0, this.videoTex, u.uVideo);
      this.#bind(1, this.recent.tex, u.uPerson);
      this.#bind(2, this.room.tex, u.uRoom);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, this.stats.tex);
      gl.generateMipmap(gl.TEXTURE_2D);

      // The part of the room you've always covered, guessed row by row.
      u = this.#pass(this.fill, this.prog.fill);
      this.#bind(0, this.room.tex, u.uRoom);
      gl.uniform1f(u.uLod, Math.log2(this.size.rw / FILL_W));
      gl.uniform1f(u.uStep, 1 / FILL_W);
      gl.uniform1i(u.uSteps, FILL_W);
      gl.uniform1f(u.uRoomLevels, this.roomLevels);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 4. The picture.
    u = this.#pass(null, this.prog.screen);
    this.#bind(0, this.videoTex, u.uVideo);
    this.#bind(1, this.recent.tex, u.uPerson);
    this.#bind(2, this.room.tex, u.uRoom);
    this.#bind(3, this.stats.tex, u.uStats);
    this.#bind(4, this.frozen.tex, u.uFrozen);
    this.#bind(5, this.frozenMask.tex, u.uFrozenMask);
    this.#bind(6, this.person.tex, u.uPersonNow);
    this.#bind(7, this.fill.tex, u.uFill);
    gl.uniform1i(u.uPhase, PHASES[phase] ?? 0);
    gl.uniform1f(u.uT, t);
    gl.uniform1f(u.uAsh, dust.ash);
    gl.uniform1f(u.uLife, LIFE);
    gl.uniform1f(u.uAspect, this.size.aspect);
    gl.uniform1f(u.uReduced, reduced ? 1 : 0);
    gl.uniform1f(u.uStatsLevel, this.statsLevel);
    gl.uniform2f(u.uWind, dust.wind.x, dust.wind.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 5. The dust, only while it's moving.
    if (!reduced && (phase === 'dissolving' || phase === 'returning')) {
      u = this.#pass(null, this.prog.speck);
      this.#bind(0, this.frozen.tex, u.uFrozen);
      this.#bind(1, this.frozenMask.tex, u.uFrozenMask);
      gl.uniform2i(u.uGrid, this.size.gridX, this.size.gridY);
      gl.uniform1f(u.uT, t);
      gl.uniform1f(u.uLife, LIFE);
      gl.uniform1f(u.uAspect, this.size.aspect);
      gl.uniform1f(u.uSpeed, dust.speed * DRIFT);
      gl.uniform1f(u.uSize, (this.canvas.width / this.size.gridX) * dust.size);
      gl.uniform1f(u.uAsh, dust.ash);
      gl.uniform2f(u.uWind, dust.wind.x, dust.wind.y);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, this.size.gridX * this.size.gridY);
      gl.disable(gl.BLEND);
    }
    return true;
  }
}
