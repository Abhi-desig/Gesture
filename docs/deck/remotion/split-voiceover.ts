// Splits a voice-over made in the ElevenLabs app as one take, with a pause of
// a second or more between lines, into the film's lines: one MP3 per scene in
// public/voiceover/, plus durations.json, as generate-voiceover.ts makes.
//   npm run split-voiceover -- path/to/take.mp3
// Without a path it reads public/voiceover/full.mp3.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { SCENES, VO_LEAD, VO_TAIL } from './src/script.ts';

const src = process.argv[2] ?? 'public/voiceover/full.mp3';
const OUT = 'public/voiceover';
const PRE = 0.08; // kept before each line's first sound
const POST = 0.15; // and after its last, for the decay

const seconds = (file: string) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

const total = seconds(src);
const log = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-af', 'silencedetect=noise=-38dB:d=0.9', '-f', 'null', '-'], {
  encoding: 'utf8',
}).stderr;
const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
let pauses = starts.map((start, i) => ({ start, end: ends[i] ?? total }));

// Silence at the very start or end of the take is not a pause between lines.
let first = 0;
let last = total;
if (pauses[0]?.start < 0.05) first = pauses.shift()!.end;
if (pauses.at(-1)?.end! > total - 0.05) last = pauses.pop()!.start;

const needed = SCENES.length - 1;
if (pauses.length < needed) {
  console.error(`Found ${pauses.length} pauses of 0.9 s or more, but ${SCENES.length} lines need ${needed}. Leave a longer pause between lines.`);
  process.exit(1);
}
// More pauses than gaps (a long breath inside a line): the longest ones are the gaps.
pauses = pauses
  .sort((a, b) => b.end - b.start - (a.end - a.start))
  .slice(0, needed)
  .sort((a, b) => a.start - b.start);

const durations: Record<string, number> = {};
for (const [i, scene] of SCENES.entries()) {
  const from = Math.max(0, (i === 0 ? first : pauses[i - 1].end) - PRE);
  const to = Math.min(total, (i === needed ? last : pauses[i].start) + POST);
  const file = `${OUT}/${scene.id}.mp3`;
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-ss', from.toFixed(3), '-t', (to - from).toFixed(3), '-i', src,
    '-af', `afade=t=in:d=0.01,afade=t=out:st=${(to - from - 0.03).toFixed(3)}:d=0.03`,
    '-c:a', 'libmp3lame', '-b:a', '192k', file,
  ]);
  durations[scene.id] = seconds(file);
  const span = VO_LEAD + durations[scene.id] + VO_TAIL;
  const warn = scene.maxSeconds && span > scene.maxSeconds ? `  (longer than its ${scene.maxSeconds} s of footage: shorten the line)` : '';
  console.log(`${scene.id.padEnd(9)} ${durations[scene.id].toFixed(1)} s  from ${from.toFixed(2)} s${warn}`);
}
writeFileSync(`${OUT}/durations.json`, JSON.stringify(durations, null, 2));
console.log(`Done: ${SCENES.length} lines in ${OUT}. Open the studio or render to hear them.`);
