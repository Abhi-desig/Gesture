// The deck's look, for the film: Jelly's colours, Inter, and one motion style.
import { loadFont } from '@remotion/fonts';
import { Easing, staticFile } from 'remotion';

export const C = {
  bg: '#FFFCFA',
  card: '#FFF4EC',
  plum: '#2B1638',
  muted: '#6B5C74',
  rose: '#F2618D',
  berry: '#D94886',
  magenta: '#A82A6C',
  peach: '#FFC09E',
  line: '#E5D3DC',
};

// "Premium" motion: one curve for most things, ease-out for entrances.
export const EASE = Easing.bezier(0.4, 0, 0.2, 1);
export const ENTER = Easing.bezier(0.16, 1, 0.3, 1);
export const EXIT = Easing.bezier(0.3, 0, 1, 1);

export const FONT = 'Inter';
for (const [weight, file] of [
  ['400', 'Regular'],
  ['500', 'Medium'],
  ['600', 'SemiBold'],
  ['700', 'Bold'],
] as const) {
  loadFont({ family: FONT, url: staticFile(`fonts/Inter-${file}.otf`), weight });
}

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
