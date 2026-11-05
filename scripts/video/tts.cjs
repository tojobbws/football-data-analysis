// ElevenLabs TTS for every clip segment, with character timestamps (they time the subtitles and the cuts).
// Cached: a segment is only re-generated when its text changes.
// usage: node tts.cjs [YYYY-MM-DD] [c0 c1 ...]
const fs = require('fs');
const path = require('path');
const { dateArg, dayDir, readJson } = require('./lib.cjs');

const VOICE = 'KhBRXgEQjvfdIyXOu7G3';
const MODEL = 'eleven_v4';
const TAGS = ['[excited] ', '[energetic] ', '[excited] ', '[confident] ']; // intro, analysis, pick, outro
const KEY = process.env.ELEVENLABS_API_KEY;

/** One voice take: <vdir>/s<i>.mp3 + s<i>.json (text with its tag, character alignment). Skipped when the text is unchanged. */
async function speak(text, vdir, i, label = '') {
  fs.mkdirSync(vdir, { recursive: true });
  const jf = path.join(vdir, `s${i}.json`);
  if (fs.existsSync(jf) && readJson(jf).text === text) { console.log(label, i, 'cached'); return; }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL, language_code: 'th', voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
  });
  if (!res.ok) throw new Error(`${label} ${i}: ${res.status} ${await res.text()}`);
  const j = await res.json();
  fs.writeFileSync(path.join(vdir, `s${i}.mp3`), Buffer.from(j.audio_base64, 'base64'));
  fs.writeFileSync(jf, JSON.stringify({ text, alignment: j.alignment, normalized: j.normalized_alignment }));
  console.log(label, i, 'speech ends', j.alignment.character_end_times_seconds.at(-1).toFixed(2) + 's');
}

module.exports = { speak, VOICE, MODEL };

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
