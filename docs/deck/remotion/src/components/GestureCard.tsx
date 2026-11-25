// Over gesture footage: the gesture's tile, and the state it switches at `at`
// seconds, such as disarmed to armed. Also says what the phone may not show,
// as when the fist is made above the shot.
import { Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, clamp, ENTER, FONT } from '../theme';

export const GestureCard: React.FC<{ tile: string; title: string; before: string; after: string; at: number }> = ({
  tile,
  title,
  before,
  after,
  at,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const card = interpolate(frame, [0.2 * fps, 0.7 * fps, durationInFrames - 0.4 * fps, durationInFrames - 0.1 * fps], [0, 1, 1, 0], clamp);
  const done = interpolate(frame, [at * fps, (at + 0.35) * fps], [0, 1], { ...clamp, easing: ENTER });
  return (
    <div
      style={{
        position: 'absolute',
        left: 80,
        top: 96,
        padding: 28,
        borderRadius: 32,
        backgroundColor: 'rgba(255, 252, 250, 0.94)',
        boxShadow: '0 18px 40px rgba(20, 8, 28, 0.22)',
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        fontFamily: FONT,
        opacity: card,
        translate: interpolate(card, [0, 1], ['0px 16px', '0px 0px']),
      }}
    >
      <Img src={staticFile(`tiles/${tile}.png`)} style={{ width: 150, height: 150, borderRadius: 38 }} />
      <div>
        <div style={{ fontSize: 34, fontWeight: 600, color: C.plum }}>{title}</div>
        <div
          style={{
            marginTop: 14,
            display: 'inline-block',
            padding: '10px 24px',
            borderRadius: 999,
            fontSize: 30,
            fontWeight: 600,
            color: done > 0.5 ? 'white' : C.muted,
            backgroundColor: done > 0.5 ? C.rose : 'transparent',
            border: `3px solid ${done > 0.5 ? C.rose : C.line}`,
            scale: interpolate(done, [0, 0.6, 1], [1, 1.06, 1]),
          }}
        >
          {done > 0.5 ? after : before}
        </div>
      </div>
    </div>
  );
};
