// "Kickoff", a 16-bar drive groove in D mixolydian for the เข็มทิศฟุตบอล intro film. Original score for the
// take-one code music engine (engine adapted from anidoodle, Apache-2.0).
//   bars 0-1   intro   drums from the first frame (the list racing past), pluck pickup in bar 1
//   bars 2-9   groove  D C G G twice; e-piano stabs join at bar 6
//   bars 10-13 lift    the hook an octave up (the record wall)
//   bars 14-15 home    one rolled D chord on the end card, then the ring
import { line } from "file:///C:/Users/staff2/.claude/skills/take-one/scripts/music/plan.mjs";

const BPB = 4, BARS = 16, BPM = 126;
const L = (t, s, role, v = 0.7, extra = {}) => line(t, s, { role, v, bpb: BPB, ...extra });
const byBar = (role, v, fn, extra = {}) => { const out = []; for (let b = 0; b < BARS; b++) { const s = fn(b, b % 4); if (s) out.push(...L(b * 4, s, role, v, extra)); } return out; };
const CH = ["D", "C", "G", "G"];
const PAD = ["[F#3 A3 D4 E4]", "[E3 G3 C4 D4]", "[D3 G3 B3 D4]", "[D3 G3 B3 E4]"];
const BASS = ["D2:1.5 D2:.5 r:1 A1:1", "C2:1.5 C2:.5 r:1 G1:1", "G1:1.5 G1:.5 r:1 D2:1", "G1:1.5 G1:.5 A1:1 B1:1"];
const STAB = ["r:.5 [F#4 A4 D5]:.5 r:1 [F#4 A4 D5]:.5 r:1.5", "r:.5 [E4 G4 C5]:.5 r:1 [E4 G4 C5]:.5 r:1.5", "r:.5 [D4 G4 B4]:.5 r:1 [D4 G4 B4]:.5 r:1.5", "r:.5 [D4 G4 B4]:.5 r:1 [E4 G4 B4]:.5 r:1.5"];
const LEAD = [
  null,
  "r:2.5 A4:.5 B4:.5 D5:.5",
  "E5:1 D5:.5 A4:1 r:1.5", "r:.5 G4:.5 A4:.5 C5:1 B4:.5 A4:1", "B4:1.5 A4:.5 G4:1 r:1", "r:2 A4:.5 B4:.5 D5:1",
  "F#5:1 E5:.5 D5:1 r:1.5", "r:.5 E5:.5 G5:1 E5:.5 D5:.5 C5:1", "D5:1.5 B4:.5 G4:1 A4:1", "B4:2 r:1 D5:1",
  "A5:1 F#5:.5 E5:.5 D5:1 E5:1", "G5:1.5 E5:.5 C5:1 D5:1", "B5:1 A5:.5 G5:.5 D5:1 B4:1", "A5:2 G5:.5 F#5:.5 E5:1",
  "D5:4", null,
];
export default () => {
  const end = (b) => b >= 14;
  const pad = byBar("accomp", 0.58, (b, c) => (b === 14 ? "[D3 F#3 A3 D4 E4]:4" : b === 15 ? null : `${PAD[c]}:4`), { roll: 0.02 });
  const keys = byBar("inner", 0.6, (b, c) => (b >= 6 && b < 14 ? STAB[c] : null), { roll: 0.015 });
  const lead = byBar("melody", 0.74, (b) => LEAD[b]);
  const bass = byBar("bass", 0.78, (b, c) => (b === 14 ? "D2:4" : b === 15 ? null : BASS[c]));
  const kick = byBar("drum", 0.88, (b) => (b === 14 ? "C4:1 r:3" : b === 15 ? null : b === 13 ? "C4:1 C4:1 C4:1 C4:.5 C4:.5" : "C4:1 C4:1 C4:1 C4:1"));
  const snare = byBar("drum", 0.72, (b) => (end(b) ? null : b === 13 ? "r:1 C4:1 r:1 C4:.25 C4:.25 C4:.25 C4:.25" : "r:1 C4:1 r:1 C4:1"));
  const hats = byBar("drum", 0.5, (b) => (end(b) ? null : "C4:.5@.8 C4:.5@.45 C4:.5@.7 C4:.5@.45 C4:.5@.8 C4:.5@.45 C4:.5@.7 C4:.5@.5"));
  const harmony = Array.from({ length: BARS }, (_, b) => ({ t: b * 4, name: b >= 14 ? "D" : CH[b % 4] }));
  return {
    title: "Kickoff (drive, D mixolydian)", seed: 1107, tail: 1.6, harmony,
    plan: { style: "drive", tempo: BPM, meter: "4/4", phraseBars: 4,
      sections: [{ id: "all", bars: BARS, mood: "drive", key: "D", mode: "mixolydian", melody: ["hook"], dyn: [0.6, 0.75] }] },
    parts: [
      { id: "pad", inst: "warmPad", role: "accomp", notes: pad, gainDb: -6, opts: { cut: 2600, attack: 0.2, release: 1.0, spread: 0.7 }, send: 0.3 },
      { id: "keys", inst: "ePiano", role: "inner", notes: keys, gainDb: -2, opts: { width: 0.4 }, send: 0.25 },
      { id: "lead", inst: "softPluck", role: "melody", notes: lead, gainDb: 3, opts: { decay: 0.4, bright: 6000, delay: (60 / BPM) * 0.75, feedback: 0.22, delayMix: 0.2 }, send: 0.22 },
      { id: "bass", inst: "bass", role: "bass", notes: bass, gainDb: -6 },
      { id: "kick", inst: "kick", role: "drum", notes: kick, gainDb: 0, send: 0.06 },
      { id: "snare", inst: "snare", role: "drum", notes: snare, gainDb: 5, send: 0.25 },
      { id: "hat", inst: "hat", role: "drum", notes: hats, opts: { pan: 0.2 }, gainDb: 16, send: 0.08 },
    ],
    fx: { duck: { by: "kick", parts: ["pad", "keys"], depth: 0.3, release: 0.2 } },
  };
};
