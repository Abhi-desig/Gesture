// How it works, as a pipeline that builds left to right: the webcam, the 21
// points on the hand, a gesture's name, and only then the Mac's key press.
import { AbsoluteFill, Img, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Ambient } from '../components/Ambient';
import { VoiceOver } from '../components/Footage';
import { C, clamp, EASE, ENTER, FONT } from '../theme';

// An open hand's 21 points, in the knuckle layout Mime's tests use (palm = 1).
const MCP: [number, number][] = [[-0.45, 0.92], [0, 1], [0.42, 0.95], [0.78, 0.85]];
const LEN = [1, 1.1, 1, 0.8];
const SPREAD = [-12, -3, 6, 15];
const HAND: [number, number][] = [[0, 0], [-0.55, 0.25], [-0.85, 0.45], [-1.15, 0.72], [-1.38, 0.97]];
MCP.forEach(([x, y], i) => {
  const a = (SPREAD[i] * Math.PI) / 180;
  HAND.push([x, y], ...[0.42, 0.72, 1].map((f) => [x + Math.sin(a) * LEN[i] * f, y + Math.cos(a) * LEN[i] * f] as [number, number]));
});
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

const NODE_W = 320;
const NODE_H = 260;
const NODES_X = [140, 590, 1040, 1490];
const NODE_Y = 380;

const Card: React.FC<{ i: number; at: number; label: string; sub: string; children: React.ReactNode }> = ({ i, at, label, sub, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = interpolate(frame, [at * fps, (at + 0.5) * fps], [0, 1], { ...clamp, easing: ENTER });
  return (
    <Interactive.Div
      name={`Step ${i + 1}`}
      style={{ position: 'absolute', left: NODES_X[i], top: NODE_Y, width: NODE_W, opacity: p, translate: `0px ${(1 - p) * 24}px` }}
    >
      <div
        style={{
          height: NODE_H,
          borderRadius: 32,
          backgroundColor: 'white',
          border: `2px solid ${C.line}`,
          boxShadow: '0 16px 36px rgba(43, 22, 56, 0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {children}
      </div>
      <div style={{ marginTop: 26, fontSize: 40, fontWeight: 600, color: C.plum, textAlign: 'center' }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 30, fontWeight: 500, color: C.muted, textAlign: 'center' }}>{sub}</div>
    </Interactive.Div>
  );
};

const Arrow: React.FC<{ i: number; at: number }> = ({ i, at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = interpolate(frame, [at * fps, (at + 0.45) * fps], [0, 1], { ...clamp, easing: EASE });
  const x0 = NODES_X[i] + NODE_W + 18;
  const x1 = NODES_X[i + 1] - 18;
  const y = NODE_Y + NODE_H / 2;
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} width={1} height={1}>
      <line x1={x0} y1={y} x2={x0 + (x1 - x0 - 14) * p} y2={y} stroke={C.rose} strokeWidth={5} strokeLinecap="round" />
      <polygon points={`${x1},${y} ${x1 - 18},${y - 11} ${x1 - 18},${y + 11}`} fill={C.rose} opacity={p > 0.95 ? 1 : 0} />
    </svg>
  );
};

const Webcam: React.FC = () => (
  <svg width={180} height={130} viewBox="0 0 180 130">
    <rect x={10} y={10} width={160} height={110} rx={22} fill="none" stroke={C.plum} strokeWidth={6} />
    <circle cx={90} cy={65} r={30} fill="none" stroke={C.plum} strokeWidth={6} />
    <circle cx={90} cy={65} r={11} fill={C.plum} />
    <circle cx={150} cy={30} r={6} fill="#2E9E6B" />
  </svg>
);

const Points: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = 70;
  const P = HAND.map(([x, y]) => [150 + x * k + 20, 230 - y * k] as const);
  return (
    <svg width={300} height={250} viewBox="0 0 300 250">
      {BONES.map(([a, b], j) => (
        <line key={j} x1={P[a][0]} y1={P[a][1]} x2={P[b][0]} y2={P[b][1]} stroke={C.plum} strokeOpacity={0.35}
          strokeWidth={3} opacity={interpolate(frame, [(at + 0.35) * fps, (at + 0.8) * fps], [0, 1], clamp)} />
      ))}
      {P.map(([x, y], j) => {
        // 21 points in under half a second: 20 ms apart.
        const s = interpolate(frame, [(at + j * 0.02) * fps, (at + j * 0.02 + 0.25) * fps], [0, 1], { ...clamp, easing: ENTER });
        return <circle key={j} cx={x} cy={y} r={(j % 4 === 0 && j ? 7 : 5.5) * s} fill={j % 4 === 0 && j ? C.rose : C.plum} />;
      })}
    </svg>
  );
};

const Desktops: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = interpolate(frame, [at * fps, (at + 0.7) * fps], [0, 1], { ...clamp, easing: EASE });
  const desk = (x: number, fill: string) => (
    <div style={{ position: 'absolute', left: x, top: 50, width: 200, height: 128, borderRadius: 14, backgroundColor: fill, border: `3px solid ${C.plum}` }} />
  );
  return (
    <div style={{ position: 'relative', width: 300, height: 220, overflow: 'hidden' }}>
      {desk(50 - p * 250, C.card)}
      {desk(300 - p * 250, '#FFE3EC')}
    </div>
  );
};

export const How: React.FC<{ hasVo?: boolean }> = ({ hasVo = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Ambient />
      <Interactive.Div
        name="Headline"
        style={{
          position: 'absolute',
          left: 140,
          top: 150,
          fontSize: 84,
          fontWeight: 700,
          letterSpacing: -2,
          color: C.plum,
          opacity: interpolate(frame, [0, 0.5 * fps], [0, 1], { ...clamp, easing: ENTER }),
          translate: interpolate(frame, [0, 0.5 * fps], ['0px 20px', '0px 0px'], { ...clamp, easing: ENTER }),
        }}
      >
        From hand to Mac, <span style={{ color: C.berry }}>on the device.</span>
      </Interactive.Div>
      <Card i={0} at={0.5} label="Webcam" sub="your hand, in view">
        <Webcam />
      </Card>
      <Arrow i={0} at={1.1} />
      <Card i={1} at={1.4} label="21 points" sub="read every frame">
        <Points at={1.5} />
      </Card>
      <Arrow i={1} at={2.5} />
      <Card i={2} at={2.8} label="A gesture" sub="swipe left">
        <Img src={staticFile('tiles/cap-08-swipe.png')} style={{ width: 230, height: 230, borderRadius: 40 }} />
      </Card>
      <Arrow i={2} at={3.9} />
      <Card i={3} at={4.2} label="The Mac" sub="next desktop">
        <Desktops at={5.0} />
      </Card>
      <VoiceOver id="how" has={hasVo} />
    </AbsoluteFill>
  );
};
