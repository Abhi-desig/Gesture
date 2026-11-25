// The seven gestures, as the deck's tiles: a short stagger in, then still.
import { AbsoluteFill, Img, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Ambient } from '../components/Ambient';
import { VoiceOver } from '../components/Footage';
import { C, clamp, ENTER, FONT } from '../theme';

const TILES = [
  ['cap-06-ok-sign', 'OK sign', 'Arm'],
  ['cap-07-look-pinch', 'Look + pinch', 'Focus a screen'],
  ['cap-08-swipe', 'Swipe', 'Desktops'],
  ['cap-09-palm-up-down', 'Palm up / down', 'Scroll'],
  ['cap-10-shh', 'Shh', 'Mute'],
  ['cap-11-fist', 'Fist', 'Lock'],
  ['cap-12-open-palm', 'Open palm', 'Play / pause'],
] as const;

const SIZE = 214;
const GAP = 34;
const LEFT = (1920 - (TILES.length * SIZE + (TILES.length - 1) * GAP)) / 2;

export const Gestures: React.FC<{ hasVo?: boolean }> = ({ hasVo = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Ambient />
      <Interactive.Div
        name="Headline"
        style={{
          position: 'absolute',
          left: LEFT,
          top: 250,
          fontSize: 84,
          fontWeight: 700,
          letterSpacing: -2,
          color: C.plum,
          opacity: interpolate(frame, [0, 0.5 * fps], [0, 1], { ...clamp, easing: ENTER }),
          translate: interpolate(frame, [0, 0.5 * fps], ['0px 20px', '0px 0px'], { ...clamp, easing: ENTER }),
        }}
      >
        Seven gestures, <span style={{ color: C.berry }}>each with a reason.</span>
      </Interactive.Div>
      {TILES.map(([file, name, action], i) => {
        // 60 ms apart: the whole row in under half a second.
        const at = 0.5 + i * 0.06;
        const p = interpolate(frame, [at * fps, (at + 0.5) * fps], [0, 1], { ...clamp, easing: ENTER });
        return (
          <Interactive.Div
            key={file}
            name={name}
            style={{
              position: 'absolute',
              left: LEFT + i * (SIZE + GAP),
              top: 470,
              width: SIZE,
              opacity: p,
              translate: `0px ${(1 - p) * 30}px`,
            }}
          >
            <Img src={staticFile(`tiles/${file}.png`)} style={{ width: SIZE, height: SIZE, boxShadow: '0 14px 30px rgba(43,22,56,0.08)', borderRadius: 56 }} />
            {/* Centred under the tile, and allowed into the gap, so every name stays on one line. */}
            <div style={{ width: SIZE + GAP, marginLeft: -GAP / 2, textAlign: 'center', whiteSpace: 'nowrap' }}>
              <div style={{ marginTop: 26, fontSize: 31, fontWeight: 600, color: C.plum }}>{name}</div>
              <div style={{ marginTop: 6, fontSize: 27, fontWeight: 500, color: C.muted }}>{action}</div>
            </div>
          </Interactive.Div>
        );
      })}
      <VoiceOver id="gestures" has={hasVo} />
    </AbsoluteFill>
  );
};
