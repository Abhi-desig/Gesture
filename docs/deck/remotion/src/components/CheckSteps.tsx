// What Mime does after a swipe, as steps that light up over the footage:
// the key goes out, then the desktop is read for 2 s to see if it moved.
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, clamp, ENTER, FONT } from '../theme';

export type Step = { at: number; text: string; tone?: 'ok' | 'fail' };

export const CheckSteps: React.FC<{ title: string; steps: Step[] }> = ({ title, steps }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const card = interpolate(frame, [0.2 * fps, 0.7 * fps, durationInFrames - 0.4 * fps, durationInFrames - 0.1 * fps], [0, 1, 1, 0], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: 80,
        top: 96,
        width: 'fit-content',
        minWidth: 560,
        padding: '26px 32px',
        borderRadius: 28,
        backgroundColor: 'rgba(255, 252, 250, 0.94)',
        boxShadow: '0 18px 40px rgba(20, 8, 28, 0.22)',
        fontFamily: FONT,
        opacity: card,
        translate: interpolate(card, [0, 1], ['0px 16px', '0px 0px']),
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: 3, textTransform: 'uppercase', color: C.magenta, marginBottom: 18 }}>
        {title}
      </div>
      {steps.map((s, i) => {
        const on = interpolate(frame, [s.at * fps, (s.at + 0.4) * fps], [0, 1], { ...clamp, easing: ENTER });
        const color = s.tone === 'fail' ? C.rose : s.tone === 'ok' ? '#2E9E6B' : C.plum;
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              marginTop: i ? 12 : 0,
              opacity: interpolate(on, [0, 1], [0.28, 1]),
              translate: interpolate(on, [0, 1], ['-8px 0px', '0px 0px']),
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                flex: 'none',
                backgroundColor: on > 0.5 ? color : 'transparent',
                border: `3px solid ${on > 0.5 ? color : C.line}`,
                color: 'white',
                fontSize: 20,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {s.tone === 'fail' ? '✕' : s.tone === 'ok' ? '✓' : i + 1}
            </div>
            <div style={{ fontSize: 32, fontWeight: 600, color: on > 0.5 ? color : C.muted }}>{s.text}</div>
          </div>
        );
      })}
    </div>
  );
};
