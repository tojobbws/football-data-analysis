# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary:** a Thai football fan on a phone, shortly before matches. They arrive from search ("วิเคราะห์บอล", "ผลบอล") or from the brand's social posts, usually in the evening, to see tonight's fixtures, live scores and whether a match has a เข็มทิศเกม signal. Thai is their reading language.

**Also primary (2026-10-19, ADR 0007):** readers who want the results of the model's predictions across all matches, on the performance pages, to judge whether the analysis can be trusted.

## Product Purpose

เข็มทิศฟุตบอล is a football data and analysis media brand: a website plus a Thai social presence. It turns football data, a statistical model and market prices into analysis, publishes it before kickoff, settles it after the match and shows the full track record.

The loop it exists to close: Data → Analysis → Decision → Content → Result → Track Record → Trust.

The website is the home base. Social posts drive traffic to it; it holds scores, fixtures, standings, analysis and the verifiable record. Revenue is planned from ads and sponsorship, deliberately not dependent on gambling advertisers.

Success means fans come back daily for scores and analysis, find the site through Thai search, and trust it because every call is on the record.

## Positioning

Every analysis is recorded before kickoff and settled automatically, wins and losses alike. Performance figures come from database views, never typed by hand, and include closing-line value and sample sizes. Since 2026-10-19 (ADR 0007) a tamper-proof record is no longer a requirement: the existing triggers and hash chain stay as they are, new storage needs neither, and the model's predictions for every match are kept as snapshots and measured on /performance as "ผลโมเดล", apart from the pick record.

At most one selection per match, or 🌫️ หมอกข้อมูล when no clear signal exists. The product never forces a pick. 🌫️ rounds are recorded in the hash chain and counted on /performance, but are not shown on match pages, lists or the home page (decided 2026-10-09: readers gain nothing from them there).

## Operating Context

- Fans use it on mobile, around Thai evening and late-night kickoffs. Late games (e.g. 01:30) belong to the previous evening: the scoreboard groups by football day, 06:00→06:00 Thai time.
- Two publish rounds per match: EARLY (within 24h of kickoff) and LINEUP (after lineups, 15–80 min before kickoff).
- Live scores update roughly every 30 seconds during matches.
- Admins write articles and review analyses in a protected admin area.
- Data comes from API-Football; the web app reads only from the database.

## Capabilities and Constraints

- Sections: home scoreboard, /matches (fixtures and results with a date picker), match pages, /today (วิเคราะห์บอลวันนี้), /analysis articles, /performance, admin.
- เข็มทิศเกม is chosen by rules (`rules-v0.x`). An AI ranks the same candidates in parallel as a shadow only, and may write the Thai explanation or downgrade to 🌫️. The LLM never produces probabilities or numbers.
- "มุมมองโมเดล" (model 1X2 probabilities) appears on every league, marked ⚠️ ยังไม่ผ่านการทดสอบ where the model is untuned. It is information, not a pick, must look clearly different from a เข็มทิศเกม pick, and is measured separately.
- Settlement statuses WIN, HALF_WIN, LOSS, HALF_LOSS, PUSH, VOID are shown separately; half results are never merged into win/loss.
- Thai League 1, UEL and UECL have no market odds, so เข็มทิศเกม is always 🌫️ there.
- Deploy target: Cloudflare (OpenNext). Domain not chosen yet.

## Brand Commitments

- Site name: **เข็มทิศฟุตบอล** (English: Khemthit Football). Tagline: วิเคราะห์บอลวันนี้ ด้วยข้อมูลจริง. Strings live in `apps/web/src/lib/brand.ts`.
- Feature vocabulary: เข็มทิศเกม (best signal), 🧱 กำแพง (handicap), 📈 แรงตลาด, 🐶 ม้ามืด, 🤝 เสียงตรงกัน, 🌫️ หมอกข้อมูล, วิเคราะห์เกม, ผลงานการวิเคราะห์.
- เข็มทิศเกม, วิเคราะห์เกม and ผลงานการวิเคราะห์ are written as plain text on the site: no 🧭 🔎 📊 emoji in headings, labels or copy (decided 2026-10-09). The เข็มทิศเกม feature is marked with the compass emblem image (`CompassMark`), never the emoji.
- Voice: data, probability, signal, insight, track record. Never use ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตีถูก, or any promise of winning.
- Required disclaimer: บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้
- SEO: keep the keyword "วิเคราะห์บอล" in match and day page titles.

## Evidence on Hand

- The real published record: `published_analysis`, `analysis_performance`, `analysis_calibration`, `prediction_chain_daily` and `fp_verify_prediction_chain()` in the database.
- Backtest results documented in `README.md` (e.g. ASEAN cross-league model log loss).
- No testimonials, press, user counts or partner logos exist. Do not invent them, and never state win rates or returns that are not read live from the database.

## Product Principles

1. **The record is the product.** Show losses as plainly as wins; nothing published is ever hidden or edited.
2. **One signal or none.** No pick is a valid outcome, never forced. Fan-facing pages show only picks; 🌫️ stays in the record and on /performance.
3. **Model calculates, AI explains.** Numbers come only from the model and the market; AI text never introduces figures.
4. **Information, not gambling.** Every word and layout choice should read as sports analysis media, not a betting tip sheet.
5. **Fan on a phone first.** Tonight's matches, scores and signals must be reachable in seconds on a small screen.

## Accessibility & Inclusion

WCAG 2.2 AA baseline: text contrast, 44px tap targets, keyboard and screen-reader support. Thai-first text at readable sizes on small phones, with line heights suited to Thai script and its stacked vowels and tone marks.
