// Synthesized music + SFX on the film timeline, VO placement, ducking, -14 LUFS master.
// usage: node audio.cjs [YYYY-MM-DD] [c0 c1 ...]   -> days/<date>/out/<clip>/mix.wav
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SR = 48000;

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

function writeWav(file, L, R) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4); }
  fs.writeFileSync(file, buf);
}

function build(TL) {
  const T = TL.T + (TL.exitAt != null ? 0 : 0.8); // let the audio logo ring a little past the last frame (trimmed at mux)
  const N = Math.ceil(T * SR);
  const mus = [new Float32Array(N), new Float32Array(N)];
  const sfx = [new Float32Array(N), new Float32Array(N)];
  const rnd = mulberry(42);
  const add = (bus, t0, fn, dur, gain = 1, pan = 0) => { // fn(localTime) -> sample
    const i0 = Math.max(0, Math.floor(t0 * SR)), i1 = Math.min(N, Math.floor((t0 + dur) * SR));
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = gain * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    for (let i = i0; i < i1; i++) { const v = fn(i / SR - t0); bus[0][i] += v * gl; bus[1][i] += v * gr; }
  };
  // ---- instruments ----
  const kick = (bus, t0, g = 1) => { let ph = 0; add(bus, t0, (t) => { const f = 45 + 130 * Math.exp(-t * 32); ph += 2 * Math.PI * f / SR; return (Math.sin(ph) * Math.exp(-t * 6.5) + (t < 0.004 ? (rnd() * 2 - 1) * 0.4 : 0)) * 0.9; }, 0.6, g); };
  const noiseHit = (bus, t0, dur, decay, lpF, hpF, g, pan = 0) => { let lp = 0, lp2 = 0; const a = 1 - Math.exp(-2 * Math.PI * lpF / SR), b = 1 - Math.exp(-2 * Math.PI * hpF / SR); add(bus, t0, (t) => { const x = rnd() * 2 - 1; lp += a * (x - lp); lp2 += b * (lp - lp2); return (lp - lp2) * Math.exp(-t * decay); }, dur, g, pan); };
  const clap = (bus, t0, g = 1) => { for (const d of [0, 0.011, 0.022]) noiseHit(bus, t0 + d, 0.25, d < 0.02 ? 60 : 14, 3200, 900, g * 0.9); };
  const hat = (bus, t0, g = 1, pan = 0) => noiseHit(bus, t0, 0.08, 55, 16000, 7000, g * 0.55, pan);
  const snare = (bus, t0, g = 1) => { noiseHit(bus, t0, 0.18, 26, 6000, 1200, g * 0.8); add(bus, t0, (t) => Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.5, 0.15, g); };
  const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
  const bassNote = (bus, t0, dur, note, g = 1) => { let lp = 0; const f = midi(note); const a = 1 - Math.exp(-2 * Math.PI * 520 / SR); add(bus, t0, (t) => { const x = saw(f * t) * 0.7 + Math.sin(2 * Math.PI * f * t) * 0.6; lp += a * (x - lp); const e = Math.min(1, t / 0.005) * Math.exp(-t * 3) * (t > dur - 0.02 ? Math.max(0, (dur - t) / 0.02) : 1); return lp * e; }, dur, g); };
  const chord = (bus, t0, dur, notes, g = 1, cutoff = 1800) => { for (const n of notes) for (const [det, pan] of [[-0.12, -0.6], [0, 0], [0.12, 0.6]]) { let lp = 0, lp2 = 0; const f = midi(n + det); const a = 1 - Math.exp(-2 * Math.PI * cutoff / SR); const ph0 = rnd(); add(bus, t0, (t) => { const x = saw(f * t + ph0); lp += a * (x - lp); lp2 += a * (lp - lp2); const e = Math.min(1, t / 0.01) * (0.35 + 0.65 * Math.exp(-t * 5)) * Math.min(1, Math.max(0, (dur - t) / 0.05)); return lp2 * e; }, dur, g * 0.09, pan); } };
  const riser = (bus, t0, dur, g = 1) => { let lp = 0, ph = 0; add(bus, t0, (t) => { const u = t / dur; const fc = 300 + 7000 * u * u; const a = 1 - Math.exp(-2 * Math.PI * fc / SR); lp += a * ((rnd() * 2 - 1) - lp); ph += 2 * Math.PI * (180 + 900 * u * u) / SR; return (lp * 0.8 + Math.sin(ph) * 0.25) * Math.pow(u, 1.6); }, dur, g); };
  const whoosh = (bus, t0, dur, g = 1, pan = 0) => { let lp = 0, lp2 = 0; add(bus, t0, (t) => { const u = t / dur; const fc = 400 + 5000 * Math.sin(Math.PI * u); const a = 1 - Math.exp(-2 * Math.PI * fc / SR), b = 1 - Math.exp(-2 * Math.PI * fc * 0.3 / SR); lp += a * ((rnd() * 2 - 1) - lp); lp2 += b * (lp - lp2); return (lp - lp2) * Math.pow(Math.sin(Math.PI * u), 2) * 1.6; }, dur, g, pan); };
  const boom = (bus, t0, g = 1) => { let ph = 0; add(bus, t0, (t) => { ph += 2 * Math.PI * (32 + 60 * Math.exp(-t * 6)) / SR; return Math.sin(ph) * Math.exp(-t * 2.2) * Math.min(1, t / 0.003); }, 1.8, g); noiseHit(bus, t0, 0.8, 7, 2500, 60, g * 0.5); kick(bus, t0, g * 0.8); };
  const crowd = (bus, t0, dur, g, swell) => { for (let k = 0; k < 4; k++) { let lp = 0, lp2 = 0; const fc = 900 + k * 500; const a = 1 - Math.exp(-2 * Math.PI * fc / SR), b = 1 - Math.exp(-2 * Math.PI * (fc * 0.35) / SR); const fm = 0.7 + k * 0.37, ph = rnd() * 6; add(bus, t0, (t) => { lp += a * ((rnd() * 2 - 1) - lp); lp2 += b * (lp - lp2); const e = swell(t) * (0.75 + 0.25 * Math.sin(2 * Math.PI * fm * t + ph)); return (lp - lp2) * e; }, dur, g * 0.6, k % 2 ? 0.5 : -0.5); } };
  const bell = (bus, t0, note, g = 1, pan = 0) => { const f = midi(note); add(bus, t0, (t) => (Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 2.5) + 0.4 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 6) + 0.2 * Math.sin(2 * Math.PI * f * 5.4 * t) * Math.exp(-t * 10)) * Math.min(1, t / 0.002), 2.5, g * 0.35, pan); };

  const [S0, S1, S2, S3] = TL.scenes; const Rv = TL.reveal;
  const BPM = 128, beat = 60 / BPM, bar = beat * 4;
  const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const roots = [33, 29, 36, 31];
  const grooveDef = (tStart, tEnd, energy) => { tEnd = Math.min(tEnd, T);
    for (let b = 0; ; b++) {
      const tb = tStart + b * beat; if (tb >= tEnd - 0.02) break;
      const barIx = Math.floor(b / 4) % 4, inBar = b % 4;
      kick(mus, tb, 0.85 * energy);
      if (inBar === 1 || inBar === 3) clap(mus, tb, 0.35 * energy);
      hat(mus, tb + beat / 2, 0.5 * energy, 0.3); hat(mus, tb + beat / 4 * 3, 0.18 * energy, -0.3);
      for (const off of [0.5, 0.75]) { const tn = tb + beat * off; if (tn < tEnd) bassNote(mus, tn, beat * 0.23, roots[barIx] + 12, 0.5 * energy); }
      if (inBar === 0) chord(mus, tb, Math.min(bar, tEnd - tb), prog[barIx], energy, 1400 + 1200 * energy);
    }
  };
  let groove = grooveDef;
  if (TL.type === 'opening') {
    const T0 = TL.subs[0].t0 + 0.05;
    riser(sfx, 0, T0, 0.35); boom(sfx, T0, 0.55); noiseHit(sfx, T0, 1.6, 2.2, 12000, 3000, 0.25);
    groove(T0, T, 0.75);
    crowd(sfx, 0.3, T, 0.05, (t) => Math.min(1, t / 1.5));
    const groupAt = TL.match.groups.map((g) => g.at), rowAt = TL.match.groups.flatMap((g) => g.rows.map((x) => x.at));
    for (const i of [1, ...groupAt]) whoosh(sfx, TL.subs[i].t0 - 0.2, 0.45, 0.25, i % 2 ? -0.4 : 0.4);
    for (const i of rowAt) { whoosh(sfx, TL.subs[i].t0 - 0.15, 0.5, 0.35, i % 2 ? 0.5 : -0.5); kick(sfx, TL.subs[i].t0 + 0.2, 0.35); noiseHit(sfx, TL.subs[i].t0 + 0.2, 0.6, 4, 12000, 4000, 0.12); }
  } else {
  // ---- intro: riser into the VS impact ----
  const DROP = 1.2;
  riser(sfx, 0, DROP, 0.35);
  whoosh(sfx, 0.25, 0.7, 0.3, -0.5); whoosh(sfx, 0.62, 0.55, 0.3, -0.4); whoosh(sfx, 0.78, 0.55, 0.3, 0.4);
  boom(sfx, DROP, 0.55);
  noiseHit(sfx, DROP, 1.6, 2.2, 12000, 3000, 0.25); // crash
  crowd(sfx, 0.6, S2 - 0.6, 0.05, (t) => Math.min(1, t / 1.0));
  // ---- groove A: DROP -> S2 ----
  groove(DROP, S2, 0.8);
  // ---- breakdown + drumroll: S2 -> R ----
  whoosh(sfx, S2 - 0.25, 0.5, 0.35, 0);
  chord(mus, S2, Rv - S2, [57, 60, 64, 69], 0.7, 900);
  bassNote(mus, S2, Rv - S2, 33, 0.35);
  { let tt = S2 + 0.1, k = 0; while (tt < Rv - 0.04) { const u = (tt - S2) / (Rv - S2); snare(sfx, tt, 0.12 + 0.3 * u); tt += 0.125 / (1 + 2.2 * u); k++; } }
  riser(sfx, S2, Rv - S2, 0.32);
  // ---- reveal: R ----
  whoosh(sfx, Rv - 0.3, 0.42, 0.45, 0);
  boom(sfx, Rv, 0.8);
  noiseHit(sfx, Rv, 2.2, 1.6, 13000, 2500, 0.3);
  crowd(sfx, Rv - 0.05, 3.2, 0.22, (t) => Math.min(1, t / 0.18) * Math.exp(-Math.max(0, t - 0.6) * 1.1));
  groove(Rv, S3, 1.0);
  if (S3 < T) {
  // ---- outro: audio logo ----
  whoosh(sfx, S3 - 0.15, 0.55, 0.45, 0);
  const L0 = S3 + 0.35;
  boom(sfx, L0, 0.6);
  bell(sfx, L0, 81, 0.9, -0.3); bell(sfx, L0 + 0.16, 85, 0.9, 0.3); bell(sfx, L0 + 0.32, 88, 1.0, 0); bell(sfx, L0 + 0.32, 76, 0.6, 0);
  chord(mus, L0, T - L0, [57, 61, 64, 69], 0.8, 2200);
  bassNote(mus, L0, Math.min(2.5, T - L0), 33, 0.5);
  noiseHit(sfx, L0, 2.5, 1.4, 14000, 4000, 0.22);
  }
  }
  if (TL.exitAt != null) whoosh(sfx, TL.exitAt - 0.2, 0.55, 0.45, 0);
  // fade tails
  for (const bus of [mus, sfx]) for (const ch of bus) { const f0 = Math.floor((T - 0.6) * SR); for (let i = f0; i < N; i++) ch[i] *= Math.max(0, 1 - (i - f0) / (0.6 * SR)); }
  return { mus, sfx, T };
}

const { dateArg, dayDir } = require('./lib.cjs');
const DAY = dayDir(dateArg());
const wantClips = process.argv.slice(2).filter((a) => /^c\d+$/.test(a));
const allClips = fs.readdirSync(path.join(DAY, 'out')).filter((k) => /^c\d+$/.test(k));
for (const key of wantClips.length ? wantClips : allClips) {
  const dir = path.join(DAY, 'out', key);
  const TL = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  const { mus, sfx } = build(TL);
  writeWav(path.join(dir, 'music.wav'), mus[0], mus[1]);
  writeWav(path.join(dir, 'sfx.wav'), sfx[0], sfx[1]);
  // VO track: place each segment; segment 2 is split at the reveal cut with an extra pause
  const inputs = [], parts = [];
  TL.segs.forEach((s) => {
    const f = path.join(DAY, s.file);
    if (s.cut != null) {
      inputs.push('-i', f, '-i', f);
      const a = inputs.length / 2 - 2, b = a + 1;
      parts.push(`[${a}:a]atrim=0:${s.cut},adelay=${Math.round(s.at * 1000)}|${Math.round(s.at * 1000)}[p${a}]`);
      parts.push(`[${b}:a]atrim=${s.cut},asetpts=PTS-STARTPTS,adelay=${Math.round((s.at + s.cut + s.pause) * 1000)}|${Math.round((s.at + s.cut + s.pause) * 1000)}[p${b}]`);
    } else {
      inputs.push('-i', f);
      const a = inputs.length / 2 - 1;
      parts.push(`[${a}:a]adelay=${Math.round(s.at * 1000)}|${Math.round(s.at * 1000)}[p${a}]`);
    }
  });
  const n = inputs.length / 2;
  const vo = path.join(dir, 'vo.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', parts.join(';') + ';' + Array.from({ length: n }, (_, i) => `[p${i}]`).join('') + `amix=inputs=${n}:normalize=0,aformat=channel_layouts=stereo,aresample=48000[v]`, '-map', '[v]', vo]);
  // mix: VO up front, music ducked under VO (sidechain), SFX on top
  const pre = path.join(dir, 'premix.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', vo, '-i', path.join(dir, 'music.wav'), '-i', path.join(dir, 'sfx.wav'), '-filter_complex',
    '[0:a]asplit=2[vo][sc];[vo]highpass=f=80,acompressor=threshold=0.1:ratio=3:attack=5:release=80,volume=1.9[v];' +
    '[1:a]volume=0.5[m];[m][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=260[md];' +
    '[2:a]volume=0.42[s];[v][md][s]amix=inputs=3:normalize=0:duration=longest[o]', '-map', '[o]', '-ar', '48000', pre]);
  // two-pass loudnorm to -14 LUFS, TP -1.3
  let meas = '';
  meas = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-i', pre, '-af', 'loudnorm=I=-14:TP=-1.3:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const j = JSON.parse(meas.slice(meas.lastIndexOf('{'), meas.lastIndexOf('}') + 1));
  const mix = path.join(dir, 'mix.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', pre, '-af', `loudnorm=I=-14:TP=-1.3:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000`, '-ar', '48000', mix]);
  console.log(key, 'mix', mix, 'input_i', j.input_i);
}
