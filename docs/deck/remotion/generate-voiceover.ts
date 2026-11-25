// Makes the film's voice-over with ElevenLabs: one MP3 per scene in
// public/voiceover/, plus durations.json, which sizes each scene to its line.
//
// Run it yourself in Terminal, with your own key (it never needs to leave
// your Mac):
//   export ELEVENLABS_API_KEY=your-key
//   npm run voiceover
// Optional: export ELEVENLABS_VOICE_ID=... to pick a voice from your library;
// without it, the default voice below is used.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SCENES, VO_LEAD, VO_TAIL } from './src/script.ts';

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('Set your key first:  export ELEVENLABS_API_KEY=your-key');
  process.exit(1);
}
const voiceId = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM';
const OUT = 'public/voiceover';
mkdirSync(OUT, { recursive: true });

const durations: Record<string, number> = {};
for (const [i, scene] of SCENES.entries()) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: scene.vo,
      model_id: 'eleven_multilingual_v2',
      // The lines around it, so the read flows as one narration.
      previous_text: SCENES[i - 1]?.vo,
      next_text: SCENES[i + 1]?.vo,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.2 },
    }),
  });
  if (!res.ok) {
    console.error(`${scene.id}: ElevenLabs answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const file = `${OUT}/${scene.id}.mp3`;
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const seconds = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString(),
  );
  durations[scene.id] = seconds;
  const needed = VO_LEAD + seconds + VO_TAIL;
  const warn = scene.maxSeconds && needed > scene.maxSeconds ? `  (longer than its ${scene.maxSeconds} s of footage: shorten the line)` : '';
  console.log(`${scene.id.padEnd(9)} ${seconds.toFixed(1)} s${warn}`);
}
writeFileSync(`${OUT}/durations.json`, JSON.stringify(durations, null, 2));
console.log(`Done: ${SCENES.length} lines in ${OUT}. Open the studio or render to hear them.`);
