// Julian's voice renderer v2: klattsch + LFO lanes + humanization transforms.
// Usage: node render2.mjs <out.wav> "<phoneme string>" '<mods json>' '<humanize json>'
// mods:     [{param, rateHz, depth, center, phase?, shape?}]
// humanize: {jitterHz?, legato?, effortFollow?, baseF0?, effortBase?, seed?}
//   jitterHz     - random +-Hz perturbation of every scheduled F0 target
//   legato       - multiply phoneme transition times (1 = unchanged)
//   effortFollow - effort tracks pitch: effort = effortBase + (F0-baseF0)*coef
//   seed         - PRNG seed so a render is reproducible testimony
import { compileString, FormantSynth, encodeWav } from './klattsch/src/engine/index.js';
import { writeFileSync } from 'node:fs';

const [out, str, modsJson, humJson] = process.argv.slice(2);
const mods = modsJson ? JSON.parse(modsJson) : [];
const hum = humJson ? JSON.parse(humJson) : {};
const SR = 48000;
const STEP_MS = 30;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(hum.seed ?? 20260808);

const compiled = compileString(str);
const voices = compiled.voices ?? [{ schedule: compiled.schedule, totalMs: compiled.totalMs }];
if (compiled.warnings?.length) console.error('warnings:', compiled.warnings);

function humanize(schedule) {
  const jitter = hum.jitterHz ?? 0;
  const legato = hum.legato ?? 1;
  const coef = hum.effortFollow ?? 0;
  const baseF0 = hum.baseF0 ?? 110;
  const effortBase = hum.effortBase ?? 0.45;
  return schedule.map(e => {
    const t = { ...e.target };
    let transitionMs = e.transitionMs;
    if (t.F0 !== undefined && (t.voicing ?? 0) > 0) {
      if (jitter) t.F0 += (rand() - 0.5) * 2 * jitter;
      if (coef) t.effort = Math.min(0.85, Math.max(0.15, effortBase + (t.F0 - baseF0) * coef));
      if (legato !== 1 && transitionMs) transitionMs = transitionMs * legato;
    }
    return { ...e, target: t, transitionMs };
  });
}

function withMods(schedule, totalMs) {
  if (!mods.length) return schedule;
  const events = [...schedule];
  for (let t = 0; t < totalMs; t += STEP_MS) {
    const target = {};
    for (const m of mods) {
      const ph = (m.phase ?? 0) + t / 1000 * m.rateHz;
      const osc = m.shape === 'ramp' ? (t / totalMs) * 2 - 1 : Math.sin(2 * Math.PI * ph);
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
  const synth = new FormantSynth({ sampleRate: SR, schedule: withMods(humanize(v.schedule), v.totalMs) });
  const buf = new Float32Array(N);
  synth.process(buf);
  for (let i = 0; i < N; i++) mix[i] += buf[i] / voices.length;
}
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mix[i]));
if (peak > 0) for (let i = 0; i < N; i++) mix[i] *= 0.89 / peak;

const { bytes } = encodeWav(mix, SR);
writeFileSync(out, bytes);
console.log(`wrote ${out}: ${(totalMs / 1000).toFixed(2)}s, ${voices.length} voice(s)`);
