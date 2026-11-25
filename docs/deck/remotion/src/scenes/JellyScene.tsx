// Jelly: its moods on the left, and on the right the real notch it lives in,
// saying what happened (captured screenshots, placed on a wallpaper).
import { AbsoluteFill, Img, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Ambient } from '../components/Ambient';
import { VoiceOver } from '../components/Footage';
import { C, clamp, ENTER, FONT } from '../theme';

const MOODS = ['ready', 'wink-ok', 'happy', 'shrug', 'asleep'];
const NOTCHES = ['cap-05a-good-afternoon-mac', 'cap-05b-waking-up-mac', 'cap-05c-im-awake-mac', 'cap-05d-going-to-sleep-mac'];

export const JellyScene: React.FC<{ hasVo?: boolean }> = ({ hasVo = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const per = 1.2;
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
        Jelly is the status, <span style={{ color: C.berry }}>never a helper.</span>
      </Interactive.Div>
      <Interactive.Div
        name="Jelly"
        style={{
          position: 'absolute',
          left: 170,
          top: 330,
          width: 560,
          height: 560,
          opacity: interpolate(frame, [0.2 * fps, 0.6 * fps], [0, 1], clamp),
          scale: 1 + Math.sin(t * 2) * 0.012,
        }}
      >
        {MOODS.map((m, i) => {
          const start = 0.4 + i * per;
          const o = interpolate(t, [start - 0.15, start + 0.15, start + per - 0.15, start + per + 0.15], [0, 1, 1, i === MOODS.length - 1 ? 1 : 0], clamp);
          return <Img key={m} src={staticFile(`jelly/jelly-${m}.png`)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: o }} />;
        })}
      </Interactive.Div>
      {NOTCHES.map((n, i) => {
        // One every 1.2 s, in step with the moods: the notch is where Jelly says it.
        const at = 0.8 + i * per;
        const p = interpolate(frame, [at * fps, (at + 0.5) * fps], [0, 1], { ...clamp, easing: ENTER });
        return (
          <Interactive.Div
            key={n}
            name={`Notch ${i + 1}`}
            style={{
              position: 'absolute',
              left: 900 + (i % 2) * 470,
              top: 330 + Math.floor(i / 2) * 270,
              width: 440,
              height: 219,
              opacity: p,
              translate: `0px ${(1 - p) * 24}px`,
            }}
          >
            <Img src={staticFile(`notch/${n}.png`)} style={{ width: 440, height: 219, borderRadius: 26, boxShadow: '0 16px 34px rgba(43,22,56,0.16)' }} />
          </Interactive.Div>
        );
      })}
      <VoiceOver id="jelly" has={hasVo} />
    </AbsoluteFill>
  );
};
