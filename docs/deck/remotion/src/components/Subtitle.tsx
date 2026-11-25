// The voice-over line on footage, as a plum pill at the bottom left. Behance
// plays video muted at first, so the words are on screen too.
import { Interactive, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { clamp, ENTER, EXIT, FONT } from '../theme';

export const Subtitle: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <Interactive.Div
      name="Subtitle"
      style={{
        position: 'absolute',
        left: 80,
        bottom: 84,
        maxWidth: 1240,
        padding: '26px 36px',
        borderRadius: 28,
        backgroundColor: 'rgba(43, 22, 56, 0.88)',
        boxShadow: '0 12px 32px rgba(20, 8, 28, 0.28)',
        color: 'white',
        fontFamily: FONT,
        fontWeight: 600,
        fontSize: 44,
        lineHeight: 1.3,
        opacity: interpolate(frame, [0.15 * fps, 0.55 * fps, durationInFrames - 0.4 * fps, durationInFrames - 0.1 * fps], [0, 1, 1, 0], {
          ...clamp,
          easing: [ENTER, (x) => x, EXIT],
        }),
        translate: interpolate(frame, [0.15 * fps, 0.55 * fps], ['0px 14px', '0px 0px'], { ...clamp, easing: ENTER }),
      }}
    >
      {text}
    </Interactive.Div>
  );
};

export const FootageShade: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      background: 'linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(20,8,28,0.35) 100%)',
    }}
  />
);
