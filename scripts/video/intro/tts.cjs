// Voice takes for the intro film (intro/vo/s<i>.mp3 + .json), via tts.cjs speak (cached by text).
const path = require('path');
const { readJson, bettingTalk } = require('../lib.cjs');
const { speak } = require('../tts.cjs');
(async () => {
  const s = readJson(path.join(__dirname, 'script.json'));
  for (const l of s.lines) { const bad = bettingTalk(l.text + ' ' + l.screen.join(' ')); if (bad.length) throw new Error(`${l.id}: betting talk ${bad}`); }
  for (let i = 0; i < s.lines.length; i++) await speak(s.lines[i].tag + s.lines[i].text, path.join(__dirname, 'vo'), i, s.lines[i].id);
})().catch((e) => { console.error(e.message); process.exit(1); });
