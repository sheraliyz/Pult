'use strict';

// Original soundtrack + sound effects for the promo, synthesised from scratch
// (no samples, no third-party music) and timed to the scenes in promo.html.
//   node dev/promo/sound.js                  add/replace the audio in docs/promo/*.mp4
//   node dev/promo/sound.js --wav out.wav    only write the soundtrack (16-bit WAV)
// render.js calls addSound() after encoding a video.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FFMPEG = path.join(ROOT, '.tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const OUT = path.join(ROOT, 'docs', 'promo');

const SR = 48000;
const DUR = 47; // promo.html DURATION
const N = SR * DUR;

// ---------------------------------------------------------------- helpers

let seed = 0x2f6b9e1;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const noise = () => rnd() * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (a, b, t) => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};
// Piecewise-linear automation: [[time, value], ...].
function keys(t, k) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const [t0, v0] = k[i - 1];
      const [t1, v1] = k[i];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return k[k.length - 1][1];
}
// Band-limited saw correction (polyBLEP).
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
// Zero-delay-feedback state-variable filter.
class SVF {
  constructor() {
    this.ic1 = this.ic2 = this.lp = this.bp = this.hp = 0;
  }
  step(x, fc, q) {
    const g = Math.tan((Math.PI * Math.min(fc, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - k * v1 - v2;
    return v2;
  }
}

// ---------------------------------------------------------------- mix bus

const dryL = new Float32Array(N);
const dryR = new Float32Array(N);
const sendL = new Float32Array(N);
const sendR = new Float32Array(N);
const duck = new Float32Array(N).fill(1); // pads dip under the kick
const stats = {};
let group = '';

function put(i, v, pan = 0, send = 0) {
  if (i < 0 || i >= N) return;
  const a = ((pan + 1) * Math.PI) / 4;
  const l = v * Math.cos(a);
  const r = v * Math.sin(a);
  dryL[i] += l;
  dryR[i] += r;
  if (send) {
    sendL[i] += l * send;
    sendR[i] += r * send;
  }
  (stats[group] ||= new Float32Array(N))[i] += v; // per-group sum, for the level report
}

// ---------------------------------------------------------------- instruments

const PAD_CUTOFF = [[0, 450], [4.5, 1800], [8.95, 1800], [9.3, 360], [11.5, 380], [14.6, 3400], [15.8, 2400], [36.6, 2400], [37.6, 1700], [40.6, 1900], [41.2, 3200], [47, 900]];
const PAD_LEVEL = [[0, 0], [2.4, 1], [8.95, 0.95], [9.3, 0.6], [11.5, 0.6], [14.6, 1], [16.2, 0.72], [36.6, 0.72], [37.6, 1], [47, 1]];

function pad(notes, t0, t1) {
  const att = 0.5;
  const rel = 1.4;
  const i0 = Math.floor(t0 * SR);
  const i1 = Math.min(N, Math.floor((t1 + rel) * SR));
  notes.forEach((m, n) => {
    const f = mtof(m);
    const fr = [f * Math.pow(2, -9 / 1200), f, f * Math.pow(2, 9 / 1200)];
    const ph = fr.map(() => rnd());
    const flt = new SVF();
    const pan = ((n / Math.max(1, notes.length - 1)) * 2 - 1) * 0.5;
    for (let i = i0; i < i1; i++) {
      const t = i / SR;
      let s = 0;
      for (let v = 0; v < 3; v++) {
        const dt = fr[v] / SR;
        ph[v] += dt;
        if (ph[v] >= 1) ph[v] -= 1;
        s += 2 * ph[v] - 1 - blep(ph[v], dt);
      }
      let e = Math.min(1, (t - t0) / att) * (t > t1 ? Math.max(0, 1 - (t - t1) / rel) : 1);
      e = e * e * (3 - 2 * e);
      const y = flt.step(s, keys(t, PAD_CUTOFF), 0.8);
      put(i, y * e * 0.03 * keys(t, PAD_LEVEL) * duck[i], pan, 0.45);
    }
  });
}

function bass(m, t0, len, vel) {
  const f = mtof(m);
  const flt = new SVF();
  let ph = 0;
  const i0 = Math.floor(t0 * SR);
  const n = Math.floor((len + 0.08) * SR);
  for (let k = 0; k < n; k++) {
    const t = k / SR;
    const body = Math.exp(-Math.min(t, len) * 2.2) * 0.6 + 0.4;
    const gate = t < len ? 1 : Math.max(0, 1 - (t - len) / 0.08);
    const a = Math.min(1, t / 0.006) * body * gate;
    ph += f / SR;
    // Upper harmonics keep the line audible on phone and laptop speakers.
    const s = Math.sin(2 * Math.PI * ph) + 0.35 * Math.sin(4 * Math.PI * ph) + 0.12 * Math.sin(6 * Math.PI * ph);
    put(i0 + k, flt.step(Math.tanh(s * 1.4), 900, 0.7) * a * vel * 0.14, 0, 0.04);
  }
}

function kick(t0, vel = 1) {
  const i0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let k = 0; k < 0.8 * SR; k++) {
    const t = k / SR;
    ph += (44 + 90 * Math.exp(-t * 28)) / SR;
    const a = Math.exp(-t * 7) * Math.min(1, t / 0.002);
    const click = t < 0.004 ? noise() * 0.2 * (1 - t / 0.004) : 0;
    put(i0 + k, (Math.sin(2 * Math.PI * ph) * a + click) * 0.36 * vel);
  }
  for (let k = 0; k < 0.4 * SR; k++) {
    const i = i0 + k;
    if (i < N) duck[i] = Math.min(duck[i], 1 - 0.35 * vel * Math.exp((-k / SR) * 9));
  }
}

function hat(t0, vel = 1, pan = 0.25) {
  const f = new SVF();
  const i0 = Math.floor(t0 * SR);
  for (let k = 0; k < 0.07 * SR; k++) {
    f.step(noise(), 7500, 0.7);
    put(i0 + k, f.hp * Math.exp((-k / SR) * 70) * 0.045 * vel, pan, 0.1);
  }
}

function rim(t0, vel = 1) {
  const f = new SVF();
  const i0 = Math.floor(t0 * SR);
  for (let k = 0; k < 0.12 * SR; k++) {
    const t = k / SR;
    f.step(noise(), 1900, 2);
    const s = f.bp * Math.exp(-t * 40) + 0.5 * Math.sin(2 * Math.PI * 820 * t) * Math.exp(-t * 60);
    put(i0 + k, s * 0.08 * vel, -0.1, 0.25);
  }
}

function pluck(m, t0, vel, pan) {
  const f = mtof(m);
  const flt = new SVF();
  const i0 = Math.floor(t0 * SR);
  let ph = rnd();
  const dt = f / SR;
  for (let k = 0; k < 1.0 * SR; k++) {
    const t = k / SR;
    ph += dt;
    if (ph >= 1) ph -= 1;
    const s = 2 * ph - 1 - blep(ph, dt);
    const y = flt.step(s, 300 + 3800 * Math.exp(-t * 16), 0.9);
    put(i0 + k, y * Math.exp(-t * 5.5) * Math.min(1, t / 0.003) * 0.14 * vel, pan, 0.4);
  }
}

function bell(m, t0, gain, decay = 2.5, pan = 0) {
  const f = mtof(m);
  const parts = [[1, 1, 1], [2, 0.45, 0.6], [2.76, 0.22, 0.45], [5.4, 0.08, 0.25], [8.93, 0.04, 0.15]];
  const i0 = Math.floor(t0 * SR);
  for (let k = 0; k < decay * 7 * SR; k++) {
    const t = k / SR;
    let s = 0;
    for (const [r, a, d] of parts) if (f * r < SR * 0.45) s += a * Math.sin(2 * Math.PI * f * r * t) * Math.exp(-t / (decay * d));
    put(i0 + k, s * Math.min(1, t / 0.003) * gain, pan, 0.55);
  }
}

// Low "boom" for logo hits and the reconnect moment.
function impact(t0, gain = 1) {
  const f = new SVF();
  const i0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let k = 0; k < 3.2 * SR; k++) {
    const t = k / SR;
    ph += (38 + 24 * Math.exp(-t * 6)) / SR;
    const thump = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 2.2) * Math.min(1, t / 0.004);
    const air = f.step(noise(), 900, 0.7) * Math.exp(-t * 18);
    put(i0 + k, (thump + 0.5 * air) * 0.3 * gain, 0, 0.3);
  }
}

// Filtered-noise sweep that peaks at the middle (scene changes).
function whoosh(t0, dur, gain = 1) {
  const f = new SVF();
  const i0 = Math.floor(t0 * SR);
  const n = Math.floor(dur * SR);
  for (let k = 0; k < n; k++) {
    const x = k / n;
    f.step(noise(), 300 * Math.pow(12, x), 1.2);
    put(i0 + k, f.bp * Math.pow(Math.sin(Math.PI * x), 2) * 0.2 * gain, -0.7 + 1.4 * x, 0.35);
  }
}

// Builds up to t1 and stops dead on it.
function riser(t0, t1, gain = 1) {
  const f = new SVF();
  const i0 = Math.floor(t0 * SR);
  const n = Math.floor((t1 - t0) * SR);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const x = k / n;
    f.step(noise(), 400 * Math.pow(17, x), 2);
    ph += (220 * Math.pow(4, x)) / SR;
    const tail = Math.min(1, (n - k) / (0.015 * SR));
    const s = f.bp * Math.pow(x, 2.2) + 0.25 * Math.sin(2 * Math.PI * ph) * Math.pow(x, 3);
    put(i0 + k, s * 0.16 * gain * tail, 0, 0.4);
  }
}

// The connection dies: stuttering, falling, bit-crushed buzz.
function glitch(t0) {
  const i0 = Math.floor(t0 * SR);
  const len = 0.5;
  let ph = 0;
  let f = 1200;
  let held = 0;
  for (let k = 0; k < len * SR; k++) {
    const t = k / SR;
    if (k % Math.floor(0.03 * SR) === 0) f = 80 + 1100 * Math.pow(1 - t / len, 2) * (0.6 + 0.4 * rnd());
    ph += f / SR;
    const s = (ph % 1 < 0.5 ? 0.6 : -0.6) + noise() * 0.25;
    if (k % 6 === 0) held = Math.round(s * 4) / 4;
    const block = Math.floor(t / 0.04);
    const gate = block % 3 !== 2 ? 1 : 0.15;
    const tail = Math.min(1, (len - t) / 0.03);
    put(i0 + k, held * Math.exp(-t * 3.5) * gate * tail * 0.12, block % 2 ? 0.35 : -0.35, 0.2);
  }
}

// Two falling notes under the error message.
function errTone(t0) {
  const flt = new SVF();
  [64, 60].forEach((m, j) => {
    const f = mtof(m);
    const s0 = t0 + j * 0.14;
    const i0 = Math.floor(s0 * SR);
    for (let k = 0; k < 0.6 * SR; k++) {
      const t = k / SR;
      const ph = (f * t) % 1;
      const tri = 1 - 4 * Math.abs(ph - 0.5);
      const a = Math.min(1, t / 0.005) * Math.exp(-t * 9);
      put(i0 + k, flt.step(tri, 1400, 0.7) * a * 0.1, 0, 0.2);
    }
  });
}

function click(t0, gain = 1, pitch = 2300, pan = 0) {
  const f = new SVF();
  const i0 = Math.floor(t0 * SR);
  for (let k = 0; k < 0.03 * SR; k++) {
    const t = k / SR;
    f.step(noise(), 5000, 0.7);
    const s = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 150) + 0.3 * f.hp * Math.exp(-t * 400);
    put(i0 + k, s * 0.09 * gain, pan, 0.15);
  }
}

function pop(m, t0, gain = 1, pan = 0) {
  const f = mtof(m);
  const i0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let k = 0; k < 0.35 * SR; k++) {
    const t = k / SR;
    ph += (f * (1 + 0.9 * Math.exp(-t * 45))) / SR;
    put(i0 + k, Math.sin(2 * Math.PI * ph) * Math.exp(-t * 16) * Math.min(1, t / 0.002) * 0.12 * gain, pan, 0.3);
  }
}

// ---------------------------------------------------------------- reverb (Freeverb)

function reverb() {
  const scale = SR / 44100;
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);
  const room = 0.86;
  const damp = 0.3;
  for (const [out, spread] of [[outL, 0], [outR, 23]]) {
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => ({ b: new Float32Array(Math.round((d + spread) * scale)), i: 0, z: 0 }));
    const aps = [556, 441, 341, 225].map((d) => ({ b: new Float32Array(Math.round((d + spread) * scale)), i: 0 }));
    for (let n = 0; n < N; n++) {
      const x = (sendL[n] + sendR[n]) * 0.015;
      let y = 0;
      for (const c of combs) {
        const o = c.b[c.i];
        c.z = o * (1 - damp) + c.z * damp;
        c.b[c.i] = x + c.z * room;
        if (++c.i >= c.b.length) c.i = 0;
        y += o;
      }
      for (const a of aps) {
        const o = a.b[a.i];
        a.b[a.i] = y + o * 0.5;
        if (++a.i >= a.b.length) a.i = 0;
        y = o - y;
      }
      out[n] = y * 3;
    }
  }
  return [outL, outR];
}

// ---------------------------------------------------------------- score

// [start, end, pad notes, bass root]. A minor while the story is tense,
// then I–V–vi–IV in C once Pult has reconnected.
const CHORDS = [
  [0, 2.6, [57, 60, 64, 67, 71], 45], // Am9: logo
  [2.6, 5.0, [53, 57, 60, 64, 67], 41], // Fmaj9
  [5.0, 7.0, [57, 60, 64, 67], 45], // Am7: a long task is running
  [7.0, 9.0, [53, 57, 60, 64], 41], // Fmaj7
  [9.0, 11.6, [45, 52, 57, 59], 33], // the link drops: hollow, muffled
  [11.6, 13.1, [55, 60, 62, 67], 43], // Gsus4: Pult is reconnecting
  [13.1, 14.6, [55, 59, 62, 67], 43], // G
];
const LOOP = [
  [[60, 64, 67, 71], 48], // Cmaj7
  [[55, 59, 62, 69], 43], // G6/9
  [[57, 60, 64, 67], 45], // Am7
  [[53, 57, 60, 64], 41], // Fmaj7
];
for (let k = 0, t = 14.6; t < 38.6 - 1e-6; k++, t += 2) CHORDS.push([t, t + 2, ...LOOP[k % 4]]);
CHORDS.push([38.6, 41.0, [55, 59, 62, 67], 43]); // G: leads into the end card
CHORDS.push([41.0, 45.5, [48, 55, 59, 62, 64], 36]); // Cmaj9: resolve

const chordAt = (t) => CHORDS.find(([a, b]) => t >= a - 1e-6 && t < b - 1e-6) || CHORDS[CHORDS.length - 1];

function compose() {
  // Rhythm first: the kick writes the ducking curve the pads read.
  group = 'drums';
  // 5.6–9.0: a long task is running.
  for (let t = 5.6; t < 8.95; t += 0.5) hat(t + 0.25, 0.5 + 0.5 * smooth(5.6, 7.5, t));
  for (let t = 7.0; t < 8.95; t += 0.5) kick(t, 0.55);
  // 14.6–36.6: reconnected, the groove.
  for (let k = 0; ; k++) {
    const t = 14.6 + k * 0.5;
    if (t > 36.6 - 1e-6) break;
    if (k % 2 === 0) kick(t, k % 4 === 0 ? 1 : 0.8);
    else rim(t, 0.9);
    hat(t + 0.25, k % 2 ? 1 : 0.75);
  }
  // 36.6–40.6: security / open source, lighter.
  for (let t = 36.6; t < 40.6 - 1e-6; t += 0.5) hat(t + 0.25, 0.55);

  group = 'bass';
  for (let t = 5.6; t < 8.95; t += 1.0) bass(chordAt(t)[3], t, Math.min(0.85, 9.0 - t - 0.03), 0.7);
  for (let t = 14.6; t < 36.6 - 1e-6; t += 0.5) {
    const r = chordAt(t)[3];
    bass(r, t, 0.2, 1);
    bass(r, t + 0.25, 0.16, 0.55);
  }
  for (let t = 36.6; t < 40.6 - 1e-6; t += 2) bass(chordAt(t)[3], t, 1.8, 0.8);
  bass(36, 41.0, 4.0, 0.9);

  group = 'pads';
  for (const [a, b, notes] of CHORDS) pad(notes, a, b);

  group = 'plucks';
  const seq = [0, 1, 2, 3, 2, 1, 0, 2];
  for (let k = 0, t = 22.6; t < 36.6 - 1e-6; k++, t += 0.25) {
    const notes = chordAt(t)[2];
    pluck(notes[seq[k % 8] % notes.length] + 12, t, k % 2 ? 0.6 : 1, k % 2 ? 0.35 : -0.35);
  }
  for (let k = 0, t = 36.6; t < 40.6 - 1e-6; k++, t += 0.5) {
    const notes = chordAt(t)[2];
    pluck(notes[seq[k % 8] % notes.length] + 12, t, 0.55, k % 2 ? 0.3 : -0.3);
  }

  group = 'sfx';
  // Intro: logo, name, tagline.
  impact(0.2, 0.8);
  bell(81, 0.2, 0.1, 3);
  bell(88, 0.26, 0.07, 3, 0.3);
  bell(95, 0.33, 0.05, 2.5, -0.3);
  whoosh(1.0, 0.8, 0.6);
  whoosh(4.5, 0.7, 0.8); // into the terminal
  click(6.0, 0.8); // headline
  // The link drops.
  glitch(9.0);
  errTone(9.4);
  // Pult takes over and reconnects.
  whoosh(11.0, 0.7, 1);
  impact(11.6, 0.45);
  for (let t = 11.75, k = 0; t < 14.5; t += 0.25, k++) click(t, 0.3 + 0.35 * smooth(11.75, 14.5, t), k % 2 ? 1500 : 1900, k % 2 ? 0.3 : -0.3);
  riser(12.4, 14.6, 1);
  impact(14.6, 1);
  bell(84, 14.6, 0.09, 2.2, -0.2);
  bell(88, 14.67, 0.08, 2.2, 0);
  bell(91, 14.74, 0.08, 2.4, 0.2);
  // Task finished.
  bell(86, 17.4, 0.08, 1.8, -0.15);
  bell(91, 17.49, 0.09, 2.2, 0.15);
  // Features list.
  whoosh(19.8, 0.7, 0.8);
  for (const t of [21.0, 22.6, 24.2, 26.0, 27.7]) click(t, 1.1, 2300, 0.1);
  // Phones.
  whoosh(28.6, 0.6, 0.8);
  pop(81, 29.7, 1, -0.3);
  pop(84, 30.15, 1, 0);
  pop(88, 30.6, 1, 0.3);
  // Security / open source.
  whoosh(35.8, 0.6, 0.7);
  [36.7, 37.25, 37.8].forEach((t, i) => bell([81, 84, 88][i], t, 0.06, 1.2, (i - 1) * 0.3));
  // End card.
  riser(40.0, 41.0, 0.6);
  impact(41.1, 1);
  bell(84, 41.1, 0.1, 4);
  bell(91, 41.16, 0.07, 4, 0.3);
  bell(100, 41.22, 0.04, 3.5, -0.3);
}

function render() {
  compose();
  const [revL, revR] = reverb();
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const g = Math.min(1, t / 0.02) * (1 - smooth(44.5, 46.9, t));
    L[i] = (dryL[i] + revL[i] * 0.3) * g;
    R[i] = (dryR[i] + revR[i] * 0.3) * g;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const k = 0.89 / peak;
  for (let i = 0; i < N; i++) {
    L[i] *= k;
    R[i] *= k;
  }
  return [L, R];
}

function writeWav(file, L, R) {
  const data = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    // TPDF dither down to 16 bit.
    const d = (rnd() - rnd()) / 32768;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((L[i] + d) * 32767))), i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((R[i] + d) * 32767))), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

function ffmpeg(args, opts = {}) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-y', ...args], { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').slice(-800));
  return r;
}

function makeWav(file) {
  const [L, R] = render();
  writeWav(file, L, R);
  // Loudness of each group while it plays (RMS over 50 ms windows that aren't silent).
  const W = SR / 20;
  for (const [name, buf] of Object.entries(stats)) {
    let sq = 0;
    let n = 0;
    let peak = 0;
    for (let w = 0; w + W <= N; w += W) {
      let s = 0;
      for (let i = w; i < w + W; i++) {
        s += buf[i] * buf[i];
        peak = Math.max(peak, Math.abs(buf[i]));
      }
      if (s / W > 1e-7) {
        sq += s;
        n += W;
      }
    }
    const db = (x) => (20 * Math.log10(x)).toFixed(1);
    console.log(`${name.padEnd(7)} rms ${db(Math.sqrt(sq / Math.max(1, n)))} dB  peak ${db(peak)} dB  (${(n / SR).toFixed(1)} s)`);
  }
}

// Writes the soundtrack and muxes it into each video (video stream copied as is),
// normalised to -16 LUFS / -1.5 dBTP (two-pass loudnorm).
function addSound(videos) {
  const wav = path.join(os.tmpdir(), `pult-promo-${process.pid}.wav`);
  makeWav(wav);
  const probe = ffmpeg(['-i', wav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  const start = probe.stderr.lastIndexOf('{');
  const m = JSON.parse(probe.stderr.slice(start, probe.stderr.indexOf('}', start) + 1));
  const af =
    `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
    `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  for (const video of videos) {
    const tmp = video.replace(/\.mp4$/, '.tmp.mp4');
    ffmpeg(['-i', video, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', af, '-ar', String(SR), '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp]);
    fs.renameSync(tmp, video);
    console.log('audio added', video);
  }
  fs.rmSync(wav, { force: true });
}

module.exports = { addSound };

if (require.main === module) {
  const i = process.argv.indexOf('--wav');
  if (i > 0) makeWav(path.resolve(process.argv[i + 1]));
  else addSound(['pult-promo.mp4', 'pult-promo-vertical.mp4'].map((f) => path.join(OUT, f)).filter((f) => fs.existsSync(f)));
}
