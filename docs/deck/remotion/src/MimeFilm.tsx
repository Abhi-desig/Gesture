// The film: motion graphics and your footage in turn, crossfaded, each scene as
// long as its voice-over (see script.ts).
import { linearTiming, TransitionSeries } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import React from 'react';
import { CheckSteps } from './components/CheckSteps';
import { Footage } from './components/Footage';
import { GestureCard } from './components/GestureCard';
import { NotchCallout, type NotchPath } from './components/NotchCallout';
import { FADE, SCENES } from './script';
import { Gestures } from './scenes/Gestures';
import { How } from './scenes/How';
import { Intro } from './scenes/Intro';
import { JellyScene } from './scenes/JellyScene';
import { Outro } from './scenes/Outro';

export type FilmProps = { frames: number[]; vo: Record<string, number> };

const MOTION: Record<string, React.FC<{ hasVo?: boolean }>> = {
  intro: Intro,
  how: How,
  gestures: Gestures,
  jelly: JellyScene,
  outro: Outro,
};

// What explains each piece of footage. Times are seconds into the scene. The
// notch paths were read off zoomed frames of each clip (x, y in 1280 x 720),
// and the quotes are what Jelly shows in the footage at those moments.
const FAIL_PATH: NotchPath = [
  [2.8, 488, 282], [3.3, 493, 277], [3.8, 499, 266], [4.3, 507, 267], [4.8, 508, 270], [5.3, 509, 263],
  [5.8, 520, 270], [6.3, 517, 268], [6.8, 517, 267], [7.3, 517, 267], [7.8, 514, 268], [8.4, 512, 270],
];
const WORKS_PATH: NotchPath = [[1.7, 512, 270], [2.2, 514, 264], [2.7, 509, 262], [3.3, 513, 263], [4.0, 509, 264], [4.8, 508, 257]];
const LOCK_PATH: NotchPath = [[1.3, 484, 236], [1.6, 480, 235], [1.9, 479, 235], [2.2, 479, 236], [2.5, 478, 236]];

const OVERLAYS: Record<string, React.ReactNode> = {
  arm: <GestureCard tile="cap-06-ok-sign" title="OK sign, held ½ s" before="Disarmed" after="Armed" at={1.0} />,
  check: (
    <>
      <CheckSteps
        title="After every swipe"
        steps={[
          { at: 1.0, text: 'The key goes to the Mac' },
          { at: 3.2, text: 'Mime reads the desktop for 2\u00a0s' },
          { at: 5.0, text: 'It didn’t move', tone: 'fail' },
        ]}
      />
      <NotchCallout
        path={FAIL_PATH}
        from={3.0}
        to={8.6}
        labels={[
          { from: 0, text: 'Jelly: “Hey, I’m looking”' },
          { from: 5.0, text: 'Jelly: “That didn’t work”' },
        ]}
      />
    </>
  ),
  works: (
    <>
      <CheckSteps
        title="After every swipe"
        steps={[
          { at: 0.6, text: 'The key goes to the Mac' },
          { at: 1.8, text: 'It moved, and stayed', tone: 'ok' },
        ]}
      />
      <NotchCallout path={WORKS_PATH} from={2.0} to={4.9} labels={[{ from: 0, text: 'Jelly: “Hey, I’m looking”' }]} />
    </>
  ),
  // The fist is made just above the phone's frame, so the card shows it; the
  // screen locks 2.6 s in.
  lock: (
    <>
      <GestureCard tile="cap-11-fist" title="Fist" before="Unlocked" after="Locked" at={2.6} />
      <NotchCallout path={LOCK_PATH} from={1.4} to={2.5} labels={[{ from: 0, text: 'Jelly: “See you soon”' }]} />
    </>
  ),
};

export const MimeFilm: React.FC<FilmProps> = ({ frames, vo }) => (
  <TransitionSeries>
    {SCENES.map((s, i) => {
      const Motion = MOTION[s.id];
      return (
        <React.Fragment key={s.id}>
          {i > 0 && <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />}
          <TransitionSeries.Sequence durationInFrames={frames[i]} name={s.id}>
            {s.kind === 'mg' && Motion ? (
              <Motion hasVo={Boolean(vo[s.id])} />
            ) : (
              <Footage id={s.id} footage={s.footage!} vo={s.vo} hasVo={Boolean(vo[s.id])}>
                {OVERLAYS[s.id]}
              </Footage>
            )}
          </TransitionSeries.Sequence>
        </React.Fragment>
      );
    })}
  </TransitionSeries>
);
