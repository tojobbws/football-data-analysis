---
name: daily-recap-video
description: Make the เข็มทิศเกม "สรุปผลงานการทำนาย" (Yesterday Prediction Recap) vertical video of a finished football day's คู่น่าจับตา: real scores, every pick's settled result (ทายถูก/ทายผิด), a count-up dashboard and the brand close. Use when the owner asks for the recap, "สรุปผลเมื่อวาน", "video สรุปผลงาน", "recap", or passes a finished date.
---

# Daily recap video

The owner's brief is `scripts/video/RECAP_BRIEF.md` (read it once per session). One film per finished football day, 30–45 s:
1. **opening:** night stadium, logo impact, "สรุปผลงานการทำนาย ประจำวันที่ …".
2. **one scoreboard card per pick**, in the spotlight film's order: logos, real score on split-flaps, เข็มทิศเกมเลือก …, then a drawn ✓ ทายถูก or ✕ ทายผิด.
3. **dashboard:** win-rate gauge, per-match badges, and count-up tiles for total, right, wrong and halves.
4. **closing:** lights out, a spotlight on the brand, "วิเคราะห์ทุกเกม เรียนรู้ทุกผลลัพธ์" and "เข็มทิศเกม เพราะฟุตบอลมีมากกว่าที่เห็น".

The recap shares the pipeline in `scripts/video/` with `/daily-spotlight-video`:
- the same fonts and voice;
- the synth kit and mixdown in `audio.cjs`;
- `render.cjs`.

Work files go to `scripts/video/days/<date>/recap/` and `days/<date>/out/recap/`. The film is `days/<date>/final/<date>_recap.mp4`.

## Steps

Run every step from `scripts/video/`.

1. **Facts:** run `node recap-fetch.cjs [YYYY-MM-DD]`. The default date is yesterday's football day.
   - It reads the same list the spotlight film used: the newest featured version, and each match's newest published round.
   - It also reads the final score, the settled `status`, and the summary computed exactly like /performance `daySummary`.
   - Its printout is the only source for the script.
   - If it warns that a match is not finished or not settled, stop and tell the owner. Never guess a result.
   - `--drop=m1[,m3]` leaves a pick out, only when the owner asks. The summary is then counted on the picks that stay, so it can differ from /performance for that day: tell the owner the new rate before rendering, and drop "ทุกผลตรวจสอบได้" from the summary.
2. **Script:** write `days/<date>/recap/spot.json`, copying `examples/2026-11-03.recap.json`.
   - `opening`, `matches[]`, `summary` and `closing` each carry a `segment` (the voice line), `subs[]` (`say` / `show` / `hi`, plus `onscreen: true` when the phrase is already written big on screen) and `marks`.
   - `marks` are verbatim pieces of the segment, and their first character times a visual. The required marks:
     - opening: `title`, `date`
     - each match: `score`, `pick`, `result`
     - summary: `total`, `win`, `loss`, `rate`
     - closing: `line1`, `line2`, `logo`, `tag`
   - A match line: `คู่แรก! <home> ชนะ/เสมอ/แพ้ <away> <score in Thai words> เข็มทิศเกมเลือก <pick spoken> <result word>`.
     - The away side can lead: `<away> บุกชนะ <home>`.
     - A pause is added before the result word on its own.
   - The result word must be the exact `result` from facts: ทายถูก / ทายผิด / ทายถูกครึ่ง / ทายผิดครึ่ง / เสมอตัว.
   - The summary speaks the real counts and the `rate_pct`. Its subtitles must show `<rate_pct>%`.
   - Keep the closing lines as they are.
   - Spell numbers out in Thai words in `segment` (สามต่อสอง, บวกศูนย์จุดสองห้า, สามสิบสามเปอร์เซ็นต์).
3. **Stills:** run `node recap.cjs <date> stills`.
   - It validates the script: every pick is present, the result words and scores are real, there are no banned words, and the subs are verbatim.
   - It then makes the voice (cached per segment), the timeline (it prints every phrase time and the total length) and `days/<date>/out/recap/sheet.png`.
   - Read the sheet. Keep the length at 45 s or less by shortening the text.
4. **Film:** run `node recap.cjs <date> film` in the background. It takes about 15–20 min: 8 parallel chunks, then music, SFX and mix to −14 LUFS, then the final mp4 and `final/recap_contact.png`.
   - Read the contact sheet.
   - Give the owner the path, the length and the loudness line.
5. Tell the owner what you could not check: the voice pronunciation and the music, since you cannot hear them.

## Rules

- Show every pick of the list, wrong ones included. `recap.cjs` refuses a script that leaves one out.
- Scores, picks and results come from `facts.json` only. The dashboard numbers are read from facts, never from the script.
- The rate is right ÷ (right + wrong), with halves counted as half, the same as /performance. Never present one day as a long-run accuracy.
- Show no odds, units or money words. No gambling words: ทีเด็ด, แทง, กำไร, การันตี, ชัวร์, ได้เงิน, เสียเงิน. Use the badge wording, not ได้ครึ่ง/เสียครึ่ง.
- Use only real logos (API-Football) and the site's `apps/web/public/brand` art (result badges, title). No 🧭🔎📊 emoji.
