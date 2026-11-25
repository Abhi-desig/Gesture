// Title: Jelly waves in, then the name and the one-line promise.
import { AbsoluteFill, Img, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Ambient } from '../components/Ambient';
import { VoiceOver } from '../components/Footage';
import { C, clamp, ENTER, FONT } from '../theme';

export const Intro: React.FC<{ hasVo?: boolean }> = ({ hasVo = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Ambient />
      <Interactive.Div
        name="Jelly"
        style={{
          position: 'absolute',
          left: 230,
          top: 290,
          width: 500,
          height: 500,
          opacity: interpolate(frame, [0, 0.4 * fps], [0, 1], clamp),
          scale: interpolate(frame, [0, 0.7 * fps], [0.6, 1], {
            ...clamp,
            easing: ENTER,
            output: 'perceptual-scale',
          }),
          translate: `0px ${Math.sin((frame / fps) * 2.2) * 6}px`,
        }}
      >
        <Img src={staticFile('jelly/jelly-hello.png')} style={{ width: '100%', height: '100%' }} />
      </Interactive.Div>
      <Interactive.Div
        name="Eyebrow"
        style={{
          position: 'absolute',
          left: 860,
          top: 330,
          fontSize: 30,
          fontWeight: 600,
          letterSpacing: 5,
          color: C.magenta,
          opacity: interpolate(frame, [0.35 * fps, 0.8 * fps], [0, 1], { ...clamp, easing: ENTER }),
          translate: interpolate(frame, [0.35 * fps, 0.8 * fps], ['0px 18px', '0px 0px'], { ...clamp, easing: ENTER }),
        }}
      >
        CREATIVE TECHNOLOGY · 2026
      </Interactive.Div>
      <Interactive.Div
        name="Title"
        style={{
          position: 'absolute',
          left: 852,
          top: 380,
          fontSize: 210,
          fontWeight: 700,
          letterSpacing: -6,
          color: C.plum,
          opacity: interpolate(frame, [0.45 * fps, 0.95 * fps], [0, 1], { ...clamp, easing: ENTER }),
          translate: interpolate(frame, [0.45 * fps, 0.95 * fps], ['0px 26px', '0px 0px'], { ...clamp, easing: ENTER }),
        }}
      >
        Mime
      </Interactive.Div>
      <Interactive.Div
        name="Promise"
        style={{
          position: 'absolute',
          left: 860,
          top: 650,
          width: 900,
          fontSize: 46,
          lineHeight: 1.3,
          fontWeight: 500,
          color: C.plum,
          opacity: interpolate(frame, [0.8 * fps, 1.3 * fps], [0, 1], { ...clamp, easing: ENTER }),
          translate: interpolate(frame, [0.8 * fps, 1.3 * fps], ['0px 18px', '0px 0px'], { ...clamp, easing: ENTER }),
        }}
      >
        A Mac you control with your hands, <span style={{ color: C.berry }}>through the webcam it already has.</span>
      </Interactive.Div>
      <VoiceOver id="intro" has={hasVo} />
    </AbsoluteFill>
  );
};
