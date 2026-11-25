// Points at the laptop's real notch in the footage: a ring that follows it as
// the phone moves, and Jelly's words beside it. The footage is only 720p, so
// the words are written out rather than zoomed into.
import { interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, clamp, ENTER, EXIT, FONT } from '../theme';

const K = 1920 / 1280; // the clips fill the frame: 1280 x 720 shown at 1920 x 1080
const RING_W = 200;
const RING_H = 76;

type Label = { from: number; text: string };
/** Where the notch is: [seconds into the scene, x, y] in clip pixels, read off zoomed frames. */
export type NotchPath = [number, number, number][];

const Inner: React.FC<{ path: NotchPath; offset: number; labels: Label[] }> = ({ path, offset, labels }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = (frame + offset) / fps;
  const times = path.map((p) => p[0]);
  const x = interpolate(t, times, path.map((p) => p[1]), clamp) * K;
  const y = interpolate(t, times, path.map((p) => p[2]), clamp) * K;
  const label = [...labels].reverse().find((l) => t >= l.from)?.text ?? '';
  const show = interpolate(frame, [0, 0.45 * fps, durationInFrames - 0.3 * fps, durationInFrames], [0, 1, 1, 0], {
    ...clamp,
    easing: [ENTER, (v) => v, EXIT],
  });
  // The pill follows the ring in, a beat later.
  const pill = interpolate(frame, [0.15 * fps, 0.6 * fps], [0, 1], { ...clamp, easing: ENTER });
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x - RING_W / 2,
          top: y - RING_H / 2,
          width: RING_W,
          height: RING_H,
          borderRadius: RING_H / 2,
          border: '5px solid white',
          boxShadow: `0 0 0 6px ${C.rose}66, 0 10px 30px rgba(20, 8, 28, 0.35)`,
          opacity: show,
          scale: interpolate(show, [0, 1], [1.25, 1]),
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: x + RING_W / 2 + 6,
          top: y - 2.5,
          width: 34,
          height: 5,
          borderRadius: 3,
          backgroundColor: 'white',
          opacity: show * pill,
          scale: `${pill} 1`,
          transformOrigin: 'left center',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: x + RING_W / 2 + 40,
          top: y - 34,
          height: 68,
          padding: '0 30px',
          display: 'flex',
          alignItems: 'center',
          whiteSpace: 'nowrap',
          borderRadius: 34,
          backgroundColor: 'rgba(43, 22, 56, 0.92)',
          boxShadow: '0 12px 32px rgba(20, 8, 28, 0.3)',
          color: 'white',
          fontFamily: FONT,
          fontWeight: 600,
          fontSize: 34,
          opacity: show * pill,
          translate: `${(1 - pill) * -14}px 0px`,
        }}
      >
        {label}
      </div>
    </>
  );
};

/** Shown from `from` to `to` (seconds into the scene), following `path`. */
export const NotchCallout: React.FC<{ path: NotchPath; from: number; to: number; labels: Label[] }> = ({
  path,
  from,
  to,
  labels,
}) => {
  const { fps } = useVideoConfig();
  const start = Math.round(from * fps);
  return (
    <Sequence from={start} durationInFrames={Math.round((to - from) * fps)} name="Notch callout" layout="none">
      <Inner path={path} offset={start} labels={labels} />
    </Sequence>
  );
};
