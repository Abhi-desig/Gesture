// End card: Jelly asleep, the name, the credit and where to find the code.
import { AbsoluteFill, Img, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Ambient } from '../components/Ambient';
import { VoiceOver } from '../components/Footage';
import { C, clamp, ENTER, FONT } from '../theme';

export const Outro: React.FC<{ hasVo?: boolean }> = ({ hasVo = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = (at: number) => ({
    opacity: interpolate(frame, [at * fps, (at + 0.5) * fps], [0, 1], { ...clamp, easing: ENTER }),
    translate: interpolate(frame, [at * fps, (at + 0.5) * fps], ['0px 18px', '0px 0px'], { ...clamp, easing: ENTER }),
  });
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Ambient />
      <Interactive.Div
        name="Jelly"
        style={{ position: 'absolute', left: 250, top: 300, width: 480, height: 480, ...rise(0), scale: 1 + Math.sin((frame / fps) * 1.4) * 0.01 }}
      >
        <Img src={staticFile('jelly/jelly-asleep.png')} style={{ width: '100%', height: '100%' }} />
      </Interactive.Div>
      <Interactive.Div name="Title" style={{ position: 'absolute', left: 852, top: 330, fontSize: 210, fontWeight: 700, letterSpacing: -6, color: C.plum, ...rise(0.3) }}>
        Mime
      </Interactive.Div>
      <Interactive.Div name="Credit" style={{ position: 'absolute', left: 860, top: 600, width: 920, fontSize: 36, lineHeight: 1.4, fontWeight: 500, color: C.plum, ...rise(0.6) }}>
        Concept, interaction design, testing and direction. Code by Claude Code, under my direction.
      </Interactive.Div>
      <Interactive.Div name="Link" style={{ position: 'absolute', left: 860, top: 730, fontSize: 40, fontWeight: 600, color: C.berry, ...rise(0.9) }}>
        github.com/Abhi-desig/Gesture
      </Interactive.Div>
      <VoiceOver id="outro" has={hasVo} />
    </AbsoluteFill>
  );
};
