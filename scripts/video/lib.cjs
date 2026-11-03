// Shared paths and helpers for the daily spotlight video pipeline (see .claude/skills/daily-spotlight-video).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;                       // code, pages, fonts, cached logos
const REPO = path.resolve(ROOT, '..', '..');

// read the repo .env once (DATABASE_URL, ELEVENLABS_API_KEY)
for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
}

/** The football day (06:00 to 06:00 Thai time) that is running now. */
function currentFootballDay() {
  const th = new Date(Date.now() + 7 * 3600e3 - 6 * 3600e3);
  return th.toISOString().slice(0, 10);
}

/** First YYYY-MM-DD argument, else the current football day. */
function dateArg(argv = process.argv.slice(2)) {
  return argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || currentFootballDay();
}

/** Per-day working folder: facts.json, spot.json, clips.json, vo/, out/, final/ */
function dayDir(date) {
  const d = path.join(ROOT, 'days', date);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };

module.exports = { ROOT, REPO, dateArg, dayDir, readJson, writeJson, currentFootballDay };
