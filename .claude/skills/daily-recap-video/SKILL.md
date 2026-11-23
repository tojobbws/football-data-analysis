---
name: daily-recap-video
description: Make the เข็มทิศเกม "สรุปผลงานการทำนาย" (Yesterday Prediction Recap) vertical video of a finished football day's คู่น่าจับตา: real scores, every pick's settled result (ทายถูก/ทายผิด), a count-up dashboard and the brand close. Use when the owner asks for the recap, "สรุปผลเมื่อวาน", "video สรุปผลงาน", "recap", or passes a finished date.
---

# Daily recap video

The owner's brief is `scripts/video/RECAP_BRIEF.md` (read it once per session). One film per finished football day, 30–45 s:
0. **cover (0–1 s, `makeRecapCover` in `recap.html`, `COVER` in `recap.cjs`):** a still thumbnail frame, complete from frame 0. No voice; it zooms out into the opening. Picture-led since 2026-11-22 (owner asked for a cover that catches the eye with pictures). It shows:
   - the site logo (`brand/logo-lockup.webp` on a white plate) and a pill "สรุปผลการทำนาย · <date_short>";
   - a giant "ทายถูก <shown_win>/<total>";
   - one hero card per **right** pick (owner, 2026-11-18): big crests with the picked side ringed green, the real score, the pick subtitle (e.g. เลือกสวีเดน ไม่แพ้), the league logo and the ถูก badge;
   - the picked crests as a faded collage behind, and the เข็มทิศเกม title.

   A day with no right pick falls back to the shared `cover.js` with every pair and the date. `recap.html` builds this, so there is nothing to do per day: read `probe_0.00.png` and give the owner its path as the thumbnail.
1. **opening:** night stadium, logo impact, "สรุปผลงานการทำนาย ประจำวันที่ …".
2. **one scoreboard card per pick**, in the spotlight film's order: logos, real score on split-flaps, เข็มทิศเกมเลือก …, then a drawn ✓ ทายถูก or ✕ ทายผิด.
3. **dashboard:** win-rate gauge, per-match badges, and count-up tiles for total, right, wrong and เสมอตัว.
4. **closing:** lights out, a spotlight on the brand, "วิเคราะห์ทุกเกม เรียนรู้ทุกผลลัพธ์" and "เข็มทิศเกม เพราะฟุตบอลมีมากกว่าที่เห็น".
   - Optional teaser for tonight (2026-11-22): add `closing.marks.tease` (e.g. "คืนนี้" in "คืนนี้จะเลือกคู่ไหน?") after the tagline. The brand rises to the top and three "?" mystery cards flip in with "กดติดตามไว้ แล้วมาลุ้นกัน" on screen. Never name tonight's matches before the 14:00 run has fixed them.
   - To make room, `closing.marks.line1` / `line2` may be left out of the voice: the motto then rises on screen, silent (example: `days/2026-11-21/recap/spot.json` is gitignored, so copy its shape from this note).

The recap shares the pipeline in `scripts/video/` with `/daily-spotlight-video`:
- the same fonts and voice;
- the synth kit and mixdown in `audio.cjs`;
- `render.cjs`.

Work files go to `scripts/video/days/<date>/recap/` and `days/<date>/out/recap/`. The film is `days/<date>/final/<date>_recap.mp4`.

## Steps

Run every step from `scripts/video/`.

1. **Facts:** run `node recap-fetch.cjs [YYYY-MM-DD]`. The default date is yesterday's football day. From `featured-ai-v2` (ADR 0014) a list belongs to a pick day (14:00 → 14:00 Thai): its last matches (South American mornings) end around noon the next day, so make the recap of day D on D+1 from about 14:00.
   - It reads the same list the spotlight film used: the newest featured version, and each match's newest published round.
   - It also reads the final score, the settled `status`, and the summary computed exactly like /performance `daySummary`.
   - Its printout is the only source for the script.
   - If it warns that a match is not finished or not settled, stop and tell the owner. Never guess a result.
   - `--extra <fixtureId>[,<fixtureId>]` adds a match the spotlight film showed although it is not on the featured list (`fetch.cjs --extra`; 2026-11-22 Liverpool vs Man Utd). It is keyed x1 and shown first, and the summary counts it, so the rate can differ from /performance: tell the owner both rates and drop "ทุกผลตรวจสอบได้".
   - `--drop=m1[,m3]` leaves a pick out, only when the owner asks. The summary is then counted on the picks that stay, so it can differ from /performance for that day: tell the owner the new rate before rendering, and drop "ทุกผลตรวจสอบได้" from the summary.
   - The featured list can be re-ranked, and a pick withdrawn in a later round, after the spotlight film was made (2026-11-05: St. Truiden and Palmeiras left the list, their PREMATCH round had no pick). When the owner names the film's matches, check the list against `days/<date>/spot.json`. If they differ, show the owner both counts and let them choose. `--spotlight` counts the film's own picks: its order, and each match's newest round published before the film's `facts.json` was fetched. It prints the picks the site later withdrew. Its rate can differ from /performance, so drop "ทุกผลตรวจสอบได้" there as well.
2. **Script:** write `days/<date>/recap/spot.json`, copying `examples/2026-11-03.recap.json`.
   - `opening`, `matches[]`, `summary` and `closing` each carry a `segment` (the voice line), `subs[]` (`say` / `show` / `hi`, plus `onscreen: true` when the phrase is already written big on screen) and `marks`.
   - `marks` are verbatim pieces of the segment, and their first character times a visual. The required marks:
     - opening: `title`, `date`
     - each match: `score`, `pick`, `result`
     - summary: `total`, `win`, `loss`, `rate`
     - closing: `line1`, `line2`, `logo`, `tag`
   - A match line: `คู่แรก! <home> ชนะ/เสมอ/แพ้ <away> <score in Thai words> เข็มทิศเกมเลือก <team> <pick.fan.text spoken> <result word>`.
     - The pick is the football words of `pick.fan` (e.g. `เลือกลาซิโอ ไม่แพ้`, `เลือกไฟรบวร์ก ชนะห่างสองลูกขึ้นไป`), never the line. One subtitle must show `pick.fan.text` verbatim.
     - The away side can lead: `<away> บุกชนะ <home>`.
     - A pause is added before the result word on its own.
   - The result word must be the exact `result` from facts: ทายถูก / ทายผิด / เสมอตัว / โมฆะ. A half result is already folded into ทายถูก / ทายผิด.
   - The summary speaks `shown_win` as ถูก and `shown_loss` as ผิด (halves included), เสมอตัว if any, and the `rate_pct`. Its subtitles must show `<rate_pct>%`. Never say ถูกครึ่ง / ผิดครึ่ง.
   - Keep the closing lines as they are.
   - Spell numbers out in Thai words in `segment` (สามต่อสอง, ไม่แพ้เกินหนึ่งลูก, สามสิบสามเปอร์เซ็นต์).
3. **Stills:** run `node recap.cjs <date> stills`.
   - It validates the script: every pick is present, the result words and scores are real, there are no banned words, and the subs are verbatim.
   - It then makes the voice (cached per segment), the timeline (it prints every phrase time and the total length) and `days/<date>/out/recap/sheet.png`.
   - The printed times and the length are film time, cover included. The first still of the sheet is the cover (frame 0).
   - Read the sheet. Keep the length at 45 s or less by shortening the text.
   - `spot.pace` (optional) tightens one film: `{ "hold": 0.5, "summaryHold": 1.0, "lead": { "opening": 0.65, "match": 0.35, "closing": 1.3 }, "tail": 1.7 }` (the 2026-11-21 film, 5 picks + teaser in 45.7 s). Give a short summary line `summaryHold` ≈ 1 s, or the gauge's 1.2 s hit lands after the lights go out. Use `lead.closing` ≈ 1.3 when the motto is silent, so it rises before the voice.
4. **Film:** run `node recap.cjs <date> film` in the background. It takes about 15–20 min: 8 parallel chunks, then music, SFX and mix to −14 LUFS, then the final mp4 and `final/recap_contact.png`.
   - Read the contact sheet.
   - Give the owner the path, the length and the loudness line.
5. Tell the owner what you could not check: the voice pronunciation and the music, since you cannot hear them.

## Look

The recap has its own colour theme, "violet night + electric cyan" (owner, 2026-11-16), so it never looks like the navy/gold คู่น่าจับตา film:
- deep violet grounds, cyan accent (pills, rings, gauge, highlighted subtitle words), lilac secondary colour and text tints;
- green ✓ and red ✕ stay for ทายถูก / ทายผิด;
- the shared cover (`cover.js`) stays navy/gold for the spotlight film; `recap.html` overrides its colours under `#film #cover`.

The palette lives in `recap.html` (`:root` and the "recap theme on the shared cover" block). Keep it for every recap unless the owner asks for another; don't copy navy/gold back from `spot.html` or `cover.js`.

## Rules

- Show every pick of the list, wrong ones included. `recap.cjs` refuses a script that leaves one out.
- Scores, picks and results come from `facts.json` only. The dashboard numbers are read from facts, never from the script.
- The rate is right ÷ (right + wrong), with halves counted as half, the same as /performance. So it can differ from the shown counts (2026-11-08: ถูก 3 ผิด 2 shows 63%, not 60%); the dashboard note says it is counted like the site's performance page. Never present one day as a long-run accuracy.
- Show no odds, units or money words, and no betting line or half-result words (owner, 2026-11-11, after TikTok removed the 2026-11-08 recap for "LAZIO +0.25" and "ทายถูกครึ่ง"): no +0.25 / บวกศูนย์จุดสองห้า, O/U, แฮนดิแคป, ถูกครึ่ง / ผิดครึ่ง / ได้ครึ่ง / เสียครึ่ง. No gambling words: ทีเด็ด, แทง, กำไร, การันตี, ชัวร์, ได้เงิน, เสียเงิน. `recap.cjs` (`bettingTalk` in `lib.cjs`) rejects them in the voice and on screen.
- Use only real logos (API-Football) and the site's `apps/web/public/brand` art (result badges, title). No 🧭🔎📊 emoji.
