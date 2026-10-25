#!/usr/bin/env node
// What Gesture costs the Mac right now, per process, averaged over a minute.
//
//   node scripts/measure-load.mjs [seconds]
//
// Samples macOS `top` (CPU % and its POWER column, the same "energy impact"
// Activity Monitor shows) for every process that is Gesture's:
//   - the engine: the hidden Chrome with Gesture's own profile, and its helpers
//     (the GPU and renderer helpers do the hand tracking);
//   - the desktop app, its Node server, and the orb's WebKit processes;
// and reads the page's own frame rate from the server's heartbeats. Run it with
// the camera on and the page hidden, before and after a change, so a claim of
// "lighter" is a measured one. Read-only: it changes nothing.

import { execFileSync } from 'node:child_process';

const SECONDS = Number(process.argv[2] ?? 60);
const STEP = 5;
const ENGINE_PROFILE = 'Application Support/Gesture/Engine';

const ps = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/);
    return m && { pid: Number(m[1]), ppid: Number(m[2]), started: new Date(m[3]), command: m[4] };
  })
  .filter(Boolean);

const engine = ps.find((p) => p.command.includes(ENGINE_PROFILE) && !p.command.includes('--type='));
const app = ps.find((p) => /target\/(debug|release)\/gesture$|Gesture\.app\/Contents\/MacOS/.test(p.command));
const groups = new Map();
const add = (name, p) => p && groups.set(p.pid, name);

if (engine) {
  add('engine: browser', engine);
  for (const p of ps.filter((q) => q.ppid === engine.pid)) {
    const type = p.command.match(/--type=([\w-]+)/)?.[1] ?? 'helper';
    const kind = /--utility-sub-type=([\w.]+)/.exec(p.command)?.[1]?.split('.').pop();
    add(`engine: ${type}${kind ? ` (${kind})` : ''}`, p);
  }
}
if (app) {
  add('app', app);
  for (const p of ps.filter((q) => q.ppid === app.pid)) add('server (node)', p);
  // The orb's WebKit processes belong to launchd, not the app; they are the
  // ones started within a few seconds after it.
  for (const p of ps.filter((q) => /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(q.command))) {
    const gap = (p.started - app.started) / 1000;
    if (gap >= 0 && gap < 30) add(`orb: WebKit ${p.command.match(/com\.apple\.WebKit\.(\w+)/)[1]}`, p);
  }
}
if (groups.size === 0) {
  console.error('No Gesture processes found. Is the app running?');
  process.exit(1);
}

const args = ['-l', String(Math.round(SECONDS / STEP) + 1), '-s', String(STEP), '-stats', 'pid,cpu,power'];
for (const pid of groups.keys()) args.push('-pid', String(pid));
const out = execFileSync('top', args, { encoding: 'utf8' });

// The first sample is since boot; average the rest.
const samples = out.split(/^PID\s+%CPU\s+POWER\s*$/m).slice(2);
const sums = new Map();
for (const sample of samples) {
  for (const line of sample.trim().split('\n')) {
    const [pid, cpu, power] = line.trim().split(/\s+/).map(Number);
    if (!groups.has(pid)) continue;
    const s = sums.get(pid) ?? { cpu: 0, power: 0 };
    sums.set(pid, { cpu: s.cpu + cpu, power: s.power + power });
  }
}

let fps = null;
try {
  const recent = JSON.parse(execFileSync('curl', ['-s', '--max-time', '2', 'http://127.0.0.1:4321/recent'], { encoding: 'utf8' }));
  const beats = recent.events.filter((e) => e.type === 'heartbeat').slice(-Math.round(SECONDS / 2));
  if (beats.length) fps = beats.reduce((a, b) => a + (b.fps ?? 0), 0) / beats.length;
} catch {
  // No server: the frame rate is just left out.
}

const rows = [...groups].map(([pid, name]) => {
  const s = sums.get(pid) ?? { cpu: 0, power: 0 };
  return { name, pid, cpu: s.cpu / samples.length, power: s.power / samples.length };
});
const merged = new Map();
for (const r of rows) {
  const m = merged.get(r.name) ?? { cpu: 0, power: 0 };
  merged.set(r.name, { cpu: m.cpu + r.cpu, power: m.power + r.power });
}

console.log(`Gesture over ${samples.length * STEP} s (${new Date().toISOString()})`);
console.log('process'.padEnd(34), 'CPU %'.padStart(7), 'energy'.padStart(8));
let cpu = 0;
let power = 0;
for (const [name, m] of [...merged].sort((a, b) => b[1].power - a[1].power)) {
  cpu += m.cpu;
  power += m.power;
  console.log(name.padEnd(34), m.cpu.toFixed(1).padStart(7), m.power.toFixed(1).padStart(8));
}
console.log('total'.padEnd(34), cpu.toFixed(1).padStart(7), power.toFixed(1).padStart(8));
if (fps !== null) console.log(`page frame rate: ${fps.toFixed(1)} fps`);
