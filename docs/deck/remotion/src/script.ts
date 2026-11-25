// The film's story, scene by scene: what the voice says and what is on screen.
// Edit the lines here, then run `npm run voiceover` again; each scene's length
// follows its voice-over.
//
// kind 'mg' scenes are motion graphics; 'footage' scenes are your phone clips
// (public/footage), each only as long as the moment it shows.

export type Scene = {
  id: string;
  kind: 'mg' | 'footage';
  vo: string;
  /** Shortest the scene may be, in seconds, so its animation can finish. */
  minSeconds: number;
  /** Footage only: how long the clip is. A longer line would outrun it. */
  maxSeconds?: number;
  footage?: string;
};

export const SCENES: Scene[] = [
  {
    id: 'intro',
    kind: 'mg',
    vo: 'This is Mime. I control my Mac with my hands, through the webcam it already has.',
    minSeconds: 5,
  },
  {
    id: 'desk',
    kind: 'footage',
    footage: 'writing',
    vo: 'I plan my day on paper, and work across two screens.',
    minSeconds: 4.5,
    maxSeconds: 8.5,
  },
  {
    id: 'problem',
    kind: 'footage',
    footage: 'pen-down',
    vo: 'But every screen switch meant putting the pen down and reaching for the keyboard.',
    minSeconds: 5,
    maxSeconds: 6,
  },
  {
    id: 'how',
    kind: 'mg',
    vo: 'So Mime reads twenty-one points on my hand, works out which gesture it is, and only then tells the Mac what to do.',
    minSeconds: 7,
  },
  {
    id: 'arm',
    kind: 'footage',
    footage: 'ok-sign',
    vo: 'Nothing fires until I arm it, with an OK sign.',
    minSeconds: 4,
    maxSeconds: 5,
  },
  {
    id: 'gestures',
    kind: 'mg',
    vo: 'Seven gestures cover the switches I make all day: desktops, scrolling, the screen I’m facing, music, mute and lock.',
    minSeconds: 7,
  },
  {
    id: 'check',
    kind: 'footage',
    footage: 'swipe-fails',
    vo: 'And it checks its own work. When a desktop doesn’t really move, Jelly says so.',
    minSeconds: 8.6,
    maxSeconds: 9,
  },
  {
    id: 'works',
    kind: 'footage',
    footage: 'swipe-works',
    vo: 'When it does, Jelly confirms it.',
    minSeconds: 5,
    maxSeconds: 6,
  },
  {
    id: 'jelly',
    kind: 'mg',
    vo: 'Jelly lives in the notch. It only reports what already happened, and never gets in the way.',
    minSeconds: 6.5,
  },
  {
    id: 'lock',
    kind: 'footage',
    footage: 'lock',
    vo: 'When I’m done, a fist locks the Mac.',
    minSeconds: 4.3,
    maxSeconds: 4.3,
  },
  {
    id: 'outro',
    kind: 'mg',
    vo: 'Mime. I designed and directed it; Claude Code wrote the code.',
    minSeconds: 5,
  },
];

export const FPS = 30;
/** Silence before each line starts, and after it ends. */
export const VO_LEAD = 0.3;
export const VO_TAIL = 0.6;
/** Crossfade between scenes, in frames. */
export const FADE = 10;

/** Each scene's length in frames, from its voice-over length when there is one. */
export const sceneFrames = (voSeconds: Record<string, number>): number[] =>
  SCENES.map((s) => {
    const vo = voSeconds[s.id];
    let seconds = Math.max(s.minSeconds, vo ? VO_LEAD + vo + VO_TAIL : 0);
    if (s.maxSeconds) seconds = Math.min(seconds, s.maxSeconds);
    return Math.round(seconds * FPS);
  });
