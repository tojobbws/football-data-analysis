---
name: daily-spotlight-video
description: Make the day's เข็มทิศเกม "คู่น่าจับตาวันนี้" vertical video (1080x1920, Thai ElevenLabs voice, subtitles, isometric 3D motion) from the production featured list. Use when the owner asks for the daily video, "ทำ video คู่น่าจับตา", "video วันนี้/พรุ่งนี้", or passes a football date.
---

# Daily spotlight video

The owner's brief is `scripts/video/BRIEF.md` (read it once per session). One film per football day:
**cover** (0–1 s, `cover.js`, `COVER` in `timeline.cjs`: a still thumbnail frame with the site logo, คู่น่าจับตาวันนี้, the date and every team's logo; inside clip c0, no voice; the c0 sheet's first still is the cover) → **opening** (คู่น่าจับตาวันนี้, the date, every featured match grouped by league) → **one segment per match** (intro, analysis, pick reveal) in the opening's order → **brand outro** (เข็มทิศเกม อ่านเกมด้วยข้อมูลจริง). Length is free.

Everything is code in `scripts/video/` (HTML pages driven by a deterministic `window.seek(t)`, rendered frame by frame with Playwright + the system Edge, music and SFX synthesized in `audio.cjs`). Work files go to `scripts/video/days/<date>/` (gitignored).

## Steps

Run from `scripts/video/` (first time on a machine: `npm install`; needs `ffmpeg` on PATH and Microsoft Edge).

1. **Facts:** `node fetch.cjs [YYYY-MM-DD]` (default = the current football day, 06:00 to 06:00 Thai). It reads the newest featured list version, each match's newest published pick and its `reason` text, the league importance (sets the order), and caches the real logos. Read its printout: it is the only source for the script.
   - Since the daily pick run (ADR 0014, `featured-ai-v2`) the list belongs to a **pick day** (14:00 → 14:00 Thai, named by its first day) and is chosen once after the 14:00 run, usually by 14:30 and at the latest after the 16:05 run when the AI had to retry. It never changes after that. Make the film from that point on. Before 14:00 the day has no list yet.
   - No list for the day → tell the owner, stop.
   - A match already finished (`fixture_status` FT/AET/PEN) → leave it out (owner, 2026-11-05). Already started → ask the owner.
2. **Script:** write `days/<date>/spot.json`. Copy the shape of `examples/2026-11-03.spot.json` (details below).
3. **Stills:** `node run.cjs <date> stills` runs prepare (validates the script) → ElevenLabs voice (cached per segment, so only changed text is regenerated) → timeline → one stills sheet per clip at `days/<date>/out/c*/sheet.png`. **Read every sheet** and fix overlaps, clipped names, or empty frames before rendering.
4. **Film:** `node run.cjs <date> film` (run in background; about 2.5 min of wall time per second of film, all clips in parallel) → `days/<date>/final/<date>_daily-spotlight.mp4` + `final/contact.png`. Read the contact sheet, check the order and the picks, then give the owner the path, the length and the loudness line.
5. Tell the owner what you could not check: you cannot hear the voice (team names and numbers pronunciation) or the music.

## Writing spot.json

- `opening`: `segment` = one voice line naming the date, then each league and its matches in order; `groups[]` = `{league, logo, at, rows:[{match, at}]}` where `at` is the index of the subtitle phrase that reveals that league or row. Logo path comes from `facts.json` (`league_logo`).
- `matches[]` in the opening's order, each `{match:"m<rank>", head:"คู่ที่ N", segments:[intro, analysis, pick], subs:[[...],[...],[...]], stats}`:
  - intro: `คู่แรก! / คู่ที่สอง! / คู่ที่สาม! …` + the two teams (+ competition when it helps).
  - analysis: explain **why** the pick (owner, 2026-11-05): the two `✓` facts of that match's `reason`, then one closing line that ties them to the pick, taken from the reason's summary sentence (e.g. `จึงมีสัญญาณว่ามิลาน อาจชนะไม่ขาด`). Every number from `reason`; nothing invented.
  - pick: `เข็มทิศเกมเลือก... <team> <facts pick.fan.text spoken>!` (e.g. `เกตาเฟ่ ไม่แพ้เกินหนึ่งลูก!`, show `เกตาเฟ่ ไม่แพ้เกิน 1 ลูก!`; over/under: `รวมสามประตูขึ้นไป!`). The subtitle has exactly two phrases: the lead-in, then the pick (the reveal and its pause are timed on the second phrase). Its `show` must contain `pick.fan.text` verbatim.
- `outro`: keep `เข็มทิศเกม อ่านเกมด้วยข้อมูลจริง`.
- `subs[i]` = phrases `{say, show, hi}`: `say` is a verbatim, in-order piece of the voice segment (prepare.cjs rejects anything else); `show` is what is written on screen (same words, digits allowed: say `ชนะเจ็ด` → show `ชนะ 7`); `hi` = 1-2 words of `show` lit in gold. Keep a phrase to about 30 characters (2 lines at most).
- Spell numbers out in Thai words in `segments` (`สองจุดเจ็ดห้า` for an xG, `ไม่แพ้เกินหนึ่งลูก`). Short club names fans use are fine in voice (แมนยู); the screen shows the database names.
- `stats` (the analysis card + pitch overlay; every number must be in `reason`):
  - `{kind:"reasons", title:"เหตุผลจากข้อมูล", rows:[{team?:"home"|"away", text, hi?, at}], tactic}`: the default since 2026-11-05. Up to 3 rows, one per reason as it is spoken; `team` shows that club's logo, no `team` = the closing line with a gold check. Keep `text` short (one line) and never name the pick in the title.
  - `{kind:"compare", rows:[{label, home, away, at, bar?, lowerBetter?}], tactic, defend?}`: a side-by-side table (form, table position, points).
  - `{kind:"slots", icon:"ball"|"win", title, titleAt, rows:[{team:"home"|"away", value, of, at}], tactic}`: "4 of 5" style rows.
  - `tactic`: `attack-away` (away team's arrows toward the home goal), `attack-home` (mirrored), `open` (both ways, for goals/Over). `defend: <phrase index>` raises the defending team's wall on that phrase.
  - `at` / `titleAt` = phrase index inside the analysis segment, so each row appears as it is spoken.
- Aim for about 16-19 s per match: intro ≤ 3 s of speech, analysis 8-11 s, pick ≤ 3 s. `timeline.cjs` prints every phrase time; shorten the text if a match runs long.

## Rules (from the brief and the project)

- The pick, market, line and names come from `facts.json` unchanged. Never change the pick or invent a statistic, injury, lineup or player fact.
- No odds in the film: never `ราคากลาง` or the price, in the voice or on screen (owner, 2026-11-04).
- No betting line either (owner, 2026-11-11, after TikTok removed the 2026-11-08 recap for "LAZIO +0.25" and "ทายถูกครึ่ง"): the pick is said and shown in football words from `facts.json` `pick.fan` (`lib.cjs` `fanPick`: +0.25 → ไม่แพ้, -1 → ชนะห่าง 2 ลูกขึ้นไป, over 2.5 → รวม 3 ประตูขึ้นไป). Never +0.25 / บวกศูนย์จุดสองห้า, เส้นเสมอ, O/U, over/under, แฮนดิแคป or ต่อรอง. `pick.line_label` holds the site's line for checks only. The `reason` text still carries the line (e.g. `เลือก AH เกตาเฟ่ +1.25`): never copy it. prepare.cjs (`bettingTalk`) rejects a script that does.
- An AI pick has no model probability: never show or say a percentage for it.
- A lean, never a certainty; the pick card carries "มุมมองจากข้อมูล ไม่ใช่ผลที่แน่นอน". No gambling words (ทีเด็ด, แทง, กำไร, ตามคู่นี้, การันตี, ชัวร์); prepare.cjs blocks the common ones.
- Real logo files only (API-Football club/league logos, the site's `apps/web/public/brand` images). No emoji 🧭🔎📊.
- Fan copy says เข็มทิศเกม, not tip/bet.

## Files

`fetch.cjs` (DB → facts) · `prepare.cjs` (facts + spot → clips, validation) · `tts.cjs` (ElevenLabs `eleven_v4`, voice `KhBRXgEQjvfdIyXOu7G3`, Thai, `[excited]`-style tags) · `timeline.cjs` (×1.15 speed, scene cuts and subtitle times from the character timestamps) · `spot.html` (match clip) · `opening.html` · `render.cjs` (probe / full) · `audio.cjs` (128 BPM synth music, riser/whoosh/boom/crowd/drumroll/audio logo, VO ducking, two-pass −14 LUFS) · `join.cjs` · `run.cjs`.

Known limits: API-Football logos are 150 px, so they look slightly soft when scaled up; the music is synthesized (a licensed track can replace `music.wav`). The opening list shrinks to fit when there are more than about 4 matches; check its sheet.
