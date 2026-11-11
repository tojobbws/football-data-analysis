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

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

function kickoffTh(utc) {
  const d = new Date(new Date(utc).getTime() + 7 * 3600e3);
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `เตะ ${hh}:${mm} น. · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

async function logo(url, file) {
  const f = path.join(ROOT, 'assets', 'logos', file);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const r = await fetch(url);
    if (!r.ok) throw new Error(`logo ${url}: ${r.status}`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  return `assets/logos/${file}`;
}

/**
 * A pick in plain football words, never as a betting line (owner, 2026-11-11, after TikTok removed the 2026-11-08
 * recap for "LAZIO +0.25" and "ทายถูกครึ่ง"). The words describe exactly the results the films call ทายถูก (WIN or
 * HALF_WIN, see RESULT_WORD); a PUSH is เสมอตัว.
 * Asian handicap, `line` = the picked side's own handicap, margin = its goals minus the other side's:
 *   ทายถูก when margin + high > 0 (high = line + 0.25 on a quarter line, else line), so the smallest margin is
 *   floor(-high) + 1:  2+ -> ชนะห่าง N ลูกขึ้นไป · 1 -> ชนะ · 0 -> ไม่แพ้ · -k -> ไม่แพ้เกิน k ลูก
 *   e.g. +0.25 / +0.5 / +0.75 / +1 -> ไม่แพ้ · 0 / -0.25 / -0.5 / -0.75 -> ชนะ · +1.25 / +1.5 -> ไม่แพ้เกิน 1 ลูก
 * Over/under on total goals: over -> รวม N ประตูขึ้นไป, under -> รวมไม่เกิน N ประตู (same rule on the quarter lines).
 * Returns { team: picked team name or null, text: the words without the team, label: both together }.
 */
function fanPick({ market, side, line, home, away }) {
  const L = Number(line);
  if (!Number.isFinite(L)) throw new Error(`fanPick: bad line ${line}`);
  const quarter = Math.abs(Math.round(L * 4)) % 2 === 1;
  const s = String(side).toLowerCase();
  if (market === 'OVER_UNDER' || s === 'over' || s === 'under') {
    let text;
    if (s === 'over') text = `รวม ${Math.floor(quarter ? L - 0.25 : L) + 1} ประตูขึ้นไป`;
    else if (s === 'under') { const n = Math.ceil(quarter ? L + 0.25 : L) - 1; text = n <= 0 ? 'ไม่มีประตู' : `รวมไม่เกิน ${n} ประตู`; }
    else throw new Error(`fanPick: over/under side ${side}`);
    return { team: null, text, label: text };
  }
  const team = s === 'home' ? home : s === 'away' ? away : null;
  if (!team) throw new Error(`fanPick: side ${side} needs a team name`);
  const min = Math.floor(-(quarter ? L + 0.25 : L)) + 1;
  const text = min >= 2 ? `ชนะห่าง ${min} ลูกขึ้นไป` : min === 1 ? 'ชนะ' : min === 0 ? 'ไม่แพ้' : `ไม่แพ้เกิน ${-min} ลูก`;
  return { team, text, label: `${team} ${text}` };
}

/** Result words in the films: a half result reads as the whole one (no ถูกครึ่ง / ผิดครึ่ง on social, owner 2026-11-11). */
const RESULT_WORD = { WIN: 'ทายถูก', HALF_WIN: 'ทายถูก', LOSS: 'ทายผิด', HALF_LOSS: 'ทายผิด', PUSH: 'เสมอตัว', VOID: 'โมฆะ', PENDING: 'รอผล' };

/**
 * Betting talk a film must not carry, in the voice or on screen: a signed line (+0.25, -1), a spoken one
 * (บวกศูนย์จุดสองห้า), O/U, over/under, handicap and half-result words. A score like 2-0 passes.
 * Returns the offending pieces (empty = clean).
 */
function bettingTalk(text) {
  const t = String(text);
  const hits = [];
  const re = [/(^|[^\d\w])[+\-−]\s?\d+(\.\d+)?/g, /(บวก|ลบ)\s?(ศูนย์|หนึ่ง|สอง|สาม|สี่|ห้า)/g, /O\s?\/\s?U/gi, /\b(over|under|handicap|AH)\b/gi,
    /แฮนดิแคป|ต่อรอง|ราคาบอล|ครึ่งลูก|ควบลูก|ถูกครึ่ง|ผิดครึ่ง|ได้ครึ่ง|เสียครึ่ง|สูงต่ำ|สูง\/ต่ำ|ทีเด็ด|แทง|กำไร|การันตี|ชัวร์|ได้เงิน|เสียเงิน|ตามคู่นี้|บอลเต็ง/g];
  for (const r of re) for (const m of t.matchAll(r)) hits.push(m[0].trim());
  return hits;
}

module.exports = { ROOT, REPO, dateArg, dayDir, readJson, writeJson, currentFootballDay, MONTHS, MONTHS_FULL, kickoffTh, logo, fanPick, RESULT_WORD, bettingTalk };

