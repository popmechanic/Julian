// Julian's voice-audition renderer: klattsch + schedule-level LFO modulation.
// Usage: node render.mjs <out.wav> "<phoneme string>" '<mods json>'
// mods: [{param, rateHz, depth, center, phase?, shape?}]  shape: sine|ramp
// Each mod injects partial-target events every STEP_MS, riding on top of the
// compiled schedule without disturbing other parameters' trajectories.
import { compileString, FormantSynth, encodeWav } from './klattsch/src/engine/index.js';
import { writeFileSync } from 'node:fs';

const [out, str, modsJson] = process.argv.slice(2);
const mods = modsJson ? JSON.parse(modsJson) : [];
const SR = 48000;
const STEP_MS = 30;

const compiled = compileString(str);
const voices = compiled.voices ?? [{ schedule: compiled.schedule, totalMs: compiled.totalMs }];
if (compiled.warnings?.length) console.error('warnings:', compiled.warnings);

function withMods(schedule, totalMs) {
  if (!mods.length) return schedule;
  const events = [...schedule];
  for (let t = 0; t < totalMs; t += STEP_MS) {
    const target = {};
    for (const m of mods) {
      const ph = (m.phase ?? 0) + t / 1000 * m.rateHz;
      const osc = m.shape === 'ramp'
        ? (t / totalMs) * 2 - 1
        : Math.sin(2 * Math.PI * ph);
      target[m.param] = m.center + m.depth * osc;
    }
    events.push({ atMs: t, target, transitionMs: STEP_MS });
  }
  events.sort((a, b) => a.atMs - b.atMs);
  return events;
}

const totalMs = Math.max(...voices.map(v => v.totalMs));
const N = Math.ceil(totalMs * SR / 1000);
const mix = new Float32Array(N);
for (const v of voices) {
  const synth = new FormantSynth({ sampleRate: SR, schedule: withMods(v.schedule, v.totalMs) });
  const buf = new Float32Array(N);
  synth.process(buf);
  for (let i = 0; i < N; i++) mix[i] += buf[i] / voices.length;
}
// normalize to -1 dBFS-ish
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mix[i]));
if (peak > 0) for (let i = 0; i < N; i++) mix[i] *= 0.89 / peak;

const { bytes } = encodeWav(mix, SR);
writeFileSync(out, bytes);
console.log(`wrote ${out}: ${(totalMs / 1000).toFixed(2)}s, ${voices.length} voice(s), peak ${peak.toFixed(2)}`);
