import { CalculateMetadataFunction, Composition, Folder, staticFile } from 'remotion';
import { FilmProps, MimeFilm } from './MimeFilm';
import { FADE, FPS, sceneFrames } from './script';
import { Gestures } from './scenes/Gestures';
import { How } from './scenes/How';
import { Intro } from './scenes/Intro';
import { JellyScene } from './scenes/JellyScene';
import { Outro } from './scenes/Outro';

// Each scene's length follows its voice-over, once `npm run voiceover` has
// written public/voiceover/durations.json; until then, the script's minimums.
const calculateMetadata: CalculateMetadataFunction<FilmProps> = async ({ props }) => {
  let vo: Record<string, number> = {};
  try {
    const res = await fetch(staticFile('voiceover/durations.json'));
    if (res.ok) vo = await res.json();
  } catch {
    // No voice-over yet.
  }
  const frames = sceneFrames(vo);
  return {
    durationInFrames: frames.reduce((a, b) => a + b, 0) - FADE * (frames.length - 1),
    props: { ...props, frames, vo },
  };
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="MimeFilm"
      component={MimeFilm}
      durationInFrames={60 * FPS}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ frames: [], vo: {} }}
      calculateMetadata={calculateMetadata}
    />
    <Folder name="Scenes">
      <Composition id="Intro" component={Intro} durationInFrames={5 * FPS} fps={FPS} width={1920} height={1080} />
      <Composition id="How" component={How} durationInFrames={7 * FPS} fps={FPS} width={1920} height={1080} />
      <Composition id="Gestures" component={Gestures} durationInFrames={7 * FPS} fps={FPS} width={1920} height={1080} />
      <Composition id="Jelly" component={JellyScene} durationInFrames={7 * FPS} fps={FPS} width={1920} height={1080} />
      <Composition id="Outro" component={Outro} durationInFrames={5 * FPS} fps={FPS} width={1920} height={1080} />
    </Folder>
  </>
);
