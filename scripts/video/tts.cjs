// Voice for every clip segment, with character timestamps (they time the subtitles and the cuts).
// Engine (env TTS_ENGINE): "gemini" (default since 2026-11-23, owner) or "eleven".
//  - gemini: Gemini 3.8 Flash TTS (gemini-3.8-flash-tts, voice GEMINI_TTS_VOICE) speaks the text; the
//    leading [tag] becomes its speech_metadata style. Gemini returns no timestamps, so the take is sent
//    with its text to ElevenLabs forced alignment, which returns the character times.
//  - eleven: ElevenLabs eleven_v4 text-to-speech with timestamps (the pipeline before 2026-11-23).
// Both write <vdir>/s<i>.mp3 + s<i>.json {text, alignment} in the same shape, so timeline.cjs, recap.cjs,
// insight*.cjs and match-preview.cjs read either one unchanged.
// Cached: a segment is only re-generated when its text, engine or voice changes.
// usage: node tts.cjs [YYYY-MM-DD] [c0 c1 ...]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { dateArg, dayDir, readJson } = require('./lib.cjs');

const ENGINE = (process.env.TTS_ENGINE || 'gemini').toLowerCase();
const VOICE_11 = 'KhBRXgEQjvfdIyXOu7G3';
const MODEL_11 = 'eleven_v4';
const GEMINI_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
const GEMINI_VOICE = process.env.GEMINI_TTS_VOICE || 'voice_fu7qdk3csbeb'; // owner's voice, 2026-11-23
const VOICE = ENGINE === 'gemini' ? GEMINI_VOICE : VOICE_11;
const MODEL = ENGINE === 'gemini' ? GEMINI_MODEL : MODEL_11;
const TAGS = ['[excited] ', '[energetic] ', '[excited] ', '[confident] ']; // intro, analysis, pick, outro

// the leading [tag] of a line → Gemini delivery (speech_metadata.style); one presenter, one show
const BASE_STYLE = 'Thai football TV show host, clear Thai pronunciation, brisk pace';
const STYLES = {
  excited: 'excited and upbeat',
  energetic: 'energetic and punchy',
  confident: 'confident and warm',
  calm: 'calm and clear',
};
function styleOf(tag) {
  const k = (tag.match(/\[([^\]]+)\]/) || [])[1];
  return [STYLES[k] || k, BASE_STYLE].filter(Boolean).join(', ');
}

/** ElevenLabs text-to-speech with character timestamps → { mp3: Buffer, alignment } */
async function elevenTake(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_11}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL_11, language_code: 'th', voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status} ${await res.text()}`);
  const j = await res.json();
  return { mp3: Buffer.from(j.audio_base64, 'base64'), alignment: j.alignment };
}

/** Gemini TTS → { wav: WAV bytes (24 kHz mono 16-bit with a RIFF header), usage: the response's token counts } */
async function geminiWav(spoken, style, voice = GEMINI_VOICE) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set (repo .env)');
  const content = { type: 'text', text: spoken };
  if (style) content.annotations = [{ type: 'speech_metadata', style }];
  const body = JSON.stringify({
    model: GEMINI_MODEL,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] },
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body,
    });
    if (res.ok) {
      const j = await res.json();
      const audio = (j.steps || []).filter((s) => s.type === 'model_output').flatMap((s) => s.content || []).filter((c) => c.type === 'audio').at(-1);
      if (!audio || !audio.data) throw new Error(`Gemini: no audio in the response: ${JSON.stringify(j).slice(0, 400)}`);
      return { wav: Buffer.from(audio.data, 'base64'), usage: j.usage || j.usage_metadata || j.usageMetadata || null };
    }
    const msg = `Gemini ${res.status} ${(await res.text()).slice(0, 400)}`;
    if (attempt >= 4 || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(msg);
    console.log('  retry', attempt, msg.slice(0, 120));
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
}

/** ElevenLabs forced alignment: audio + its transcript → [{text, start, end}] per character */
async function forcedAlign(mp3, spoken) {
  const form = new FormData();
  form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'take.mp3');
  form.append('text', spoken);
  const res = await fetch('https://api.elevenlabs.io/v1/forced-alignment', {
    method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form,
  });
  if (!res.ok) throw new Error(`forced alignment ${res.status} ${await res.text()}`);
  const j = await res.json();
  return { chars: j.characters, loss: j.loss };
}

/**
 * Character times for the full line (tag included, so the text matches s<i>.json like the ElevenLabs
 * take): the tag sits at 0, each spoken character takes the aligner's time for the same character.
 * A character the aligner dropped or changed borrows its neighbour's time (counted in `missed`).
 */
function toAlignment(full, tagLen, fa) {
  const characters = [...full];
  const starts = new Array(characters.length).fill(0);
  const ends = new Array(characters.length).fill(0);
  let k = 0, missed = 0, last = 0;
  for (let i = tagLen; i < characters.length; i++) {
    const c = characters[i];
    let hit = -1;
    for (let d = 0; d < 4 && k + d < fa.length; d++) if (fa[k + d].text === c) { hit = k + d; break; }
    if (hit >= 0) { starts[i] = fa[hit].start; ends[i] = fa[hit].end; last = ends[i]; k = hit + 1; }
    else { starts[i] = last; ends[i] = last; if (c.trim()) missed++; }
  }
  // a dropped character at the very end must not end the speech early
  if (fa.length) ends[ends.length - 1] = Math.max(ends.at(-1), fa.at(-1).end);
  return { alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }, missed };
}

/** One voice take: <vdir>/s<i>.mp3 + s<i>.json (text with its tag, character alignment). Skipped when unchanged. */
async function speak(text, vdir, i, label = '') {
  fs.mkdirSync(vdir, { recursive: true });
  const jf = path.join(vdir, `s${i}.json`);
  if (fs.existsSync(jf)) {
    const old = readJson(jf);
    if (old.text === text && (old.engine || 'eleven') === ENGINE && (old.voice || VOICE_11) === VOICE) { console.log(label, i, 'cached'); return; }
  }
  const mf = path.join(vdir, `s${i}.mp3`);
  let alignment, extra = {};
  if (ENGINE === 'eleven') {
    const t = await elevenTake(text);
    fs.writeFileSync(mf, t.mp3);
    alignment = t.alignment;
  } else {
    const tag = (text.match(/^\s*\[[^\]]*\]\s*/) || [''])[0];
    const spoken = text.slice(tag.length);
    const style = tag ? styleOf(tag) : BASE_STYLE;
    const wf = path.join(vdir, `s${i}.wav`);
    const g = await geminiWav(spoken, style);
    fs.writeFileSync(wf, g.wav);
    // mp3 keeps the file name every consumer reads; align on the mp3 itself so the times match it
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wf, '-ar', '44100', '-b:a', '192k', mf]);
    const { chars, loss } = await forcedAlign(fs.readFileSync(mf), spoken);
    const r = toAlignment(text, [...tag].length, chars);
    alignment = r.alignment;
    extra = { style, loss, missed: r.missed, usage: g.usage };
    if (r.missed) console.log(label, i, `aligner missed ${r.missed} characters (times borrowed from neighbours)`);
  }
  fs.writeFileSync(jf, JSON.stringify({ text, engine: ENGINE, voice: VOICE, model: MODEL, ...extra, alignment }));
  console.log(label, i, ENGINE, VOICE, 'speech ends', alignment.character_end_times_seconds.at(-1).toFixed(2) + 's');
}

module.exports = { speak, geminiWav, styleOf, VOICE, MODEL, ENGINE, TAGS };

if (require.main === module) {
  (async () => {
    const date = dateArg();
    const dir = dayDir(date);
    const clips = readJson(path.join(dir, 'clips.json'));
    const want = process.argv.slice(2).filter((a) => /^c\d+$/.test(a));
    for (const c of clips.filter((x) => !want.length || want.includes(x.key))) {
      for (let i = 0; i < c.segments.length; i++) await speak(TAGS[c.type === 'opening' ? 0 : i] + c.segments[i], path.join(dir, 'vo', c.key), i, c.key);
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
