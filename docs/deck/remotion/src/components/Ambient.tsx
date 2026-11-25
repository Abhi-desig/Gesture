// The motion graphics' background: the deck's warm white with two soft glows
// drifting slowly, so the frame never sits dead still.
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C } from '../theme';

export const Ambient: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width: 1400,
          height: 1400,
          left: 900 + Math.sin(t * 0.35) * 60,
          top: -500 + Math.cos(t * 0.3) * 40,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,231,207,0.9) 0%, rgba(255,231,207,0) 65%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 1100,
          left: -300 + Math.cos(t * 0.28) * 50,
          top: 420 + Math.sin(t * 0.32) * 40,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,214,224,0.55) 0%, rgba(255,214,224,0) 65%)',
        }}
      />
    </AbsoluteFill>
  );
};
