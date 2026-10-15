# Football Data & Analysis Platform

> **Data → Analysis → Decision → Content → Result → Track Record → Trust**
>
> บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้

สถานะ: **Phase 1–7 + 6b (AI shadow) เสร็จ** (Data Engine + Database + Odds History + Probability Engine + Candidate Generator + Publish + Settlement) — loop วิเคราะห์ → เผยแพร่ → จบเกม → ตัดสินผล → Performance ทำงานครบ

## โครงสร้าง

```text
football-platform/
├── apps/web/                 Next.js + TS + Tailwind (placeholder — UI คือ Phase 9)
├── packages/
│   ├── shared/               env (zod), logger, league ids, time utils
│   ├── football/             API-Football client + typed endpoints + mappers + odds parser
│   ├── database/             pg/Supabase access, upsert helpers, Repository, migrations runner
│   ├── analysis/             settlement rules, Dixon-Coles, Elo, market pricing, metrics, backtest
│   └── ai/                   AI shadow ranking: input จาก snapshot, prompt, Claude client, guards
├── workers/
│   ├── football-sync/        leagues, teams, fixtures, details, lineups, injuries, predictions, standings, players
│   ├── odds-sync/            odds snapshots -> odds_history
│   ├── live-score/           Cloudflare Worker: cron ทุกนาที -> sync:live (สกอร์สด)
│   └── analysis/             probabilities -> probability_predictions, backtest
├── supabase/migrations/      SQL schema (ใช้กับ Supabase CLI ได้ตรง ๆ)
├── scripts/migrate.ts        apply migrations ไปที่ DATABASE_URL
└── .github/workflows/        scheduled sync ฟรีด้วย GitHub Actions
```

Layer แยกกันชัด: **API logic อยู่ใน `packages/football` เท่านั้น**, SQL อยู่ใน `packages/database` เท่านั้น, worker แค่ประกอบขั้นตอน, เว็บอ่านจาก DB เท่านั้น (ไม่ยิง API-Football)

## เริ่มต้นใช้งาน

1. **Supabase** → สร้าง project (เลือก region Singapore) → Project Settings → Database → คัดลอก connection string (Session pooler)
2. **API-Football** → dashboard.api-football.com → คัดลอก API key
3. ตั้งค่า
   ```bash
   cp .env.example .env      # ใส่ API_FOOTBALL_KEY, DATABASE_URL, SEASON
   npm install
   npm run db:migrate        # หรือ: supabase db push
   npm test                  # 47 tests (ใช้ Postgres in-memory ไม่แตะ DB จริง)
   ```
4. ดึงข้อมูลครั้งแรก
   ```bash
   npm run job -w @fp/football-sync -- bootstrap   # leagues -> teams -> fixtures -> standings
   npm run sync:details                            # รายละเอียดนัดที่จบแล้ว (xG, events, lineups)
   npm run sync:odds
   ```

## Jobs

| คำสั่ง | ทำอะไร | ความถี่แนะนำ |
|---|---|---|
| `sync:leagues` | ลีก + season + coverage | เดือนละครั้ง |
| `sync:teams` | ทีม + สนาม | สัปดาห์ละครั้ง |
| `sync:fixtures [--from --to]` | ตารางแข่ง/ผล | วันละครั้ง (+ ชั่วโมงละครั้งช่วงแข่ง) |
| `sync:details` | events, stats, **xG**, lineups, player stats ของนัดที่จบ (20 นัด/request) | ชั่วโมงละครั้ง |
| `sync:results [--days]` | สกอร์/สถานะนัดที่เตะไปแล้วแต่ยังไม่จบใน DB + ทุกนัดที่มีบทวิเคราะห์ PENDING (20 นัด/request) | ชั่วโมงละครั้ง |
| `sync:live` | สกอร์สด + events/stats ของนัดที่กำลังเตะ (20 นัด/request) — เช็ก DB ก่อน ไม่มีนัดเตะ = ไม่ยิง API | ทุก 30 วิ ผ่าน `workers/live-score` |
| `sync:lineups [--minutes]` | ตัวจริงก่อนเตะ | ทุก 15–60 นาที |
| `sync:injuries [--days]` | ตัวเจ็บ | วันละครั้ง |
| `sync:predictions [--hours]` | API Prediction (เก็บเป็น snapshot, เป็นแค่ 1 input) | วันละครั้ง |
| `sync:standings` | ตารางคะแนน | วันละครั้ง |
| `sync:support [--last N]` | ผลการแข่งของลีกในประเทศที่อยู่เบื้องหลังบอลถ้วยข้ามลีก (`CROSS_LEAGUE_CUPS`) แต่ไม่ได้ติดตาม — ผลอย่างเดียว ไม่ขึ้นเว็บ | วันละครั้ง |
| `sync:players` | สถิตินักเตะทั้ง season (หลาย page) | สัปดาห์ละครั้ง |
| `sync:odds` | odds → `odds_history` (append-only) | ชั่วโมงละครั้ง / ถี่ขึ้นใกล้เตะ |

ทุก job บันทึก `sync_runs` (จำนวน request ที่ใช้ = ต้นทุน API) และทุก response ถูกเก็บดิบใน `api_raw_responses` ก่อน process เสมอ (ยกเว้น `live`: ยิงถี่เกินจะทำ DB บวม — ผลสุดท้ายยังถูกเก็บดิบโดย `sync:results` และ `sync:odds`: ทุก quote อยู่ใน `odds_history` แล้ว) เก็บดิบไว้ 3 วัน (`db:prune`), ส่วน odds snapshot เก็บถาวร (ไว้ใช้เป็น feature ของ model, ดู `docs/adr/0002-data-retention.md`)
**Free plan ของ API-Football มี quota ต่อวันจำกัด** — พอสำหรับพัฒนา แต่ถ้ารัน odds ทุกชั่วโมงจริงต้องใช้ plan แบบจ่ายเงิน (ดู request ที่ใช้จริงได้จาก `select job, sum(requests_used) from sync_runs group by 1`)

## Live scores (`workers/live-score`)

Cloudflare Worker cron ทุก 1 นาที แต่ละรอบ: query DB ว่ามีนัดที่กำลังเตะ / กำลังจะเตะใน 1 นาทีไหม → ไม่มี = จบ (0 request) → มี = `fixtures?ids=` (20 นัด/request) ทุก `LIVE_POLL_SECONDS` (default 30) จนครบนาที
ค่าใช้ API ≈ 120 request ต่อชั่วโมงที่มีบอลเตะ (ไม่ขึ้นกับจำนวนนัด ถ้าไม่เกิน 20 นัดพร้อมกัน)

ต่อ DB ผ่าน **Hyperdrive** (socket ของ Workers verify cert ของ Supabase pooler ไม่ผ่าน เพราะเป็น CA ของ Supabase เอง) — ตั้งครั้งแรก:
```bash
cd workers/live-score
npx wrangler hyperdrive create football-db --connection-string="<DATABASE_URL>" --caching-disabled
#   -> ใส่ id ที่ได้ใน wrangler.jsonc (id ที่ได้จาก `hyperdrive create`)
npx wrangler secret put API_FOOTBALL_KEY
npx wrangler deploy
```
`TRACKED_LEAGUES` ใน `wrangler.jsonc` ต้องตรงกับ `.env` / GitHub variable. ทดสอบ logic บนเครื่องได้ด้วย `npm run sync:live`

## Cross-league cups (เช่น ASEAN Club Championship)

ทีมในบอลถ้วยมาจากหลายลีก แต่นัดในถ้วยมีน้อย → `computeProbabilities` ผสม (50/50 ที่ score matrix, เฉพาะ sides) model ถ้วยอย่างเดียวกับ **cross-league model 2 ชั้น** (`packages/analysis/src/cross-league.ts`):
ความแข็งของทีม *ในลีกตัวเอง* (Dixon-Coles ต่อลีกในประเทศ) × ความแข็งของ *ลีก* (fit จากนัดถ้วย ซึ่งเป็นข้อมูลเดียวที่เทียบลีกกันได้). ค่าที่ใช้บันทึกใน `inputs.crossLeague`
ตั้งค่าคู่ ถ้วย → ลีกในประเทศ ที่ `CROSS_LEAGUE_CUPS` (`packages/shared/src/leagues.ts`); ทดสอบซ้ำได้ด้วย `npx tsx scripts/backtest-pooled.ts`
ผล backtest ASEAN (67 นัด, log loss 1X2): ฐาน 1.034 · ถ้วยอย่างเดียว 0.954 · รวมทุกนัดเป็น model เดียว 1.051 (แย่ลง) · **ผสม 0.926** (ดีกว่าฐาน z 2.7, ดีกว่าถ้วยอย่างเดียว z 1.4)
ยัง **ไม่เปิด pick** — ลีกที่ยังไม่ผ่าน tune ถูก gate เป็น 🌫️ เสมอ; ต้องพิสูจน์กับราคาตลาด (odds ก่อนเตะ) ก่อน

## สิ่งที่ Database บังคับเอง (ไม่ใช่แค่ code)

- `odds_history`, `api_predictions`, `analysis_candidates`, `analysis_snapshots` = **append-only** (UPDATE/DELETE ถูก reject)
- `analysis_predictions` (🧭 เข็มทิศเกม):
  - publish ได้เฉพาะ **ก่อนเตะ** และ `published_at` ใช้นาฬิกาของ DB (ย้อนเวลาไม่ได้)
  - เนื้อหาแก้ไม่ได้, ลบไม่ได้, truncate ไม่ได้
  - settle ได้ **ครั้งเดียว** (PENDING → WIN / HALF_WIN / LOSS / HALF_LOSS / PUSH / VOID) และต้องหลังจบเกม
  - **hash chain**: `record_hash = sha256(prev_hash | content)` → `select * from fp_verify_prediction_chain()` ตรวจได้ทั้งสาย, `prediction_chain_daily` = hash ประจำวันไว้โพสต์สาธารณะ
  - `NO_CLEAR_SIGNAL` (🌫️ หมอกข้อมูล) ก็ถูกบันทึกด้วย → วัด coverage ได้
- Performance คำนวณจาก view (`analysis_performance`, `analysis_calibration`) ไม่มีตัวเลขที่พิมพ์มือ และมี CLV (beat closing line) ในตัว

## Probability Engine (Phase 4)

```bash
npm run sync:fixtures -- --season 2025     # ประวัติฤดูกาลก่อน (1 request/ลีก) — ยิ่งมากโมเดลยิ่งแม่น
npm run sync:fixtures -- --season 2024
npm run model:tune                          # จูนค่าต่อลีก + เปิด/ปิดตลาด (ใช้เวลาหลายนาที, รันสัปดาห์ละครั้ง)
npm run model:backtest                      # walk-forward: DC vs Elo vs Ensemble vs base rate
npm run model:probabilities -- --days 7     # เขียน probability_predictions
```

### Tuning + Market Gate
- `model:tune` ลอง shrinkage × half-life × xG weight × totals shrink × Elo (k, home) × น้ำหนัก ensemble
- เลือกค่าจาก 70% แรกของช่วงเวลา แล้ววัดผลจริงบน **30% ล่าสุดที่ไม่ได้ใช้เลือก** (holdout)
- ตลาดจะ `ON` เฉพาะเมื่อชนะ base rate บน holdout แบบ **มีนัยสำคัญทางสถิติ** (paired test, z ≥ 1.28 = 90% one-sided) และ holdout ≥ 100 นัด → เก็บใน `model_configs` (append-only, ดูค่าที่ใช้อยู่ใน `model_configs_latest`)
- Elo จะถูกผสมเข้า 1X2 เฉพาะเมื่อดีกว่า Dixon-Coles อย่างมีนัยสำคัญบนช่วง tune (ตัดสินโดยไม่ดู holdout)
- Phase 5 จะสร้าง Candidate เฉพาะตลาดที่ `ON` เท่านั้น

- **Dixon-Coles** (`dixon-coles-v0.1`): Poisson + low-score correction, time decay (half-life 240 วัน), ผสม xG 50% เมื่อมีข้อมูล, shrinkage ให้ทีมที่ข้อมูลน้อยเข้าหาค่าเฉลี่ย
- **Elo** (`elo-v0.1`): ความเห็นที่สองสำหรับ 🤝 เสียงตรงกัน
- คำนวณ AH / O/U เฉพาะเส้นที่ตลาดเปิดจริงใน `odds_history` (ถ้ายังไม่มี odds ใช้เส้นมาตรฐาน)
- `probability` = fair probability (ตัด push ออก) → เทียบกับ no-vig market probability ได้ตรง ๆ, `inputs.distribution` เก็บ WIN/HALF_WIN/PUSH/HALF_LOSS/LOSS
- ลีกที่มีนัดจบน้อยกว่า 30 นัด (เช่น Nations League ช่วงแรก) ระบบจะข้าม ไม่เดา

## Candidate Generator (Phase 5)

```bash
npm run sync:odds
npm run model:probabilities -- --days 2
npm run model:candidates -- --hours 36
```
```sql
select * from analysis_latest_decision order by kickoff_at;   -- การตัดสินล่าสุดต่อคู่ (ยังไม่ publish)
```

- ราคาตลาด = **median no-vig ข้ามเจ้ามือ** (ต้อง ≥ 2 เจ้า, อัปเดตไม่เกิน 12 ชม.), ราคาอ้างอิง = median odds (conservative)
- ประเมิน **ทุก selection ที่ตลาดเปิด** แล้วบันทึกทั้งหมดใน `analysis_candidates` พร้อมเหตุผลที่ไม่ผ่าน
- กฎ `rules-v0.1`: edge 3–15%, EV ≥ 2%, odds 1.30–6.00, ทีมมีข้อมูลพอ, ตลาดต้อง `ON`, ไม่ใกล้เตะเกิน 15 นาที
- edge > 15% = ไม่ผ่าน (มักแปลว่าโมเดลไม่รู้ข่าวบางอย่าง เช่น ตัวหลักเจ็บ)
- 🤝 Elo agreement: 1X2/AH (O/U = ไม่มีความเห็น)
- ความแรง: STRONG / MEDIUM / LEAN — ตลาดที่ z < 1.96 ได้สูงสุดแค่ LEAN
- เลือก **1 ตัว** ที่ support score สูงสุด หรือ 🌫️ `NO_CLEAR_SIGNAL`
- ประเมินใหม่เมื่อ probabilities/config เปลี่ยน, ช่วง 3 ชม. สุดท้ายก่อนเตะ หรือ odds ขยับ (ไม่เกินทุก 3 ชม.)

## Player Impact Layer (ระหว่าง Probability Engine กับ Candidate Generator)

```bash
npm run sync:details -- --limit 2000     # ดึง lineups + สถิตินักเตะย้อนหลัง (20 นัด/request)
npm run model:tune                       # คาลิเบรต α ต่อลีก (ต้องมี ≥ 300 นัดที่มี lineup)
npm run sync:lineups && npm run model:impact
```
```sql
select * from player_impact_latest order by kickoff_at;   -- ใครขาด, ทีมเสียพลังรุก/รับเท่าไหร่
```

- โปรไฟล์นักเตะจาก 10 นัดล่าสุดของทีม: สัดส่วนนาที, attack share (ประตู/แอสซิสต์/ยิง/คีย์พาส), defence share (นาที × ตำแหน่ง × rating)
- ใครขาด: **T-1h ใช้ lineup จริง** (ตัวหลักไม่ได้ตัวจริง = ขาด, อยู่ม้านั่ง = ขาด 60%), ก่อนหน้านั้นใช้ `injuries` (Missing = 100%, Questionable = 50%)
- ปรับ λ/μ ด้วย α ที่คาลิเบรตจาก lineup ในอดีต แล้วราคาใหม่บันทึกเป็นโมเดล `dc-impact-v0.1` (แถว Dixon-Coles เดิมไม่ถูกแตะ)
- Candidate Generator ใช้ราคาที่ปรับแล้ว **เฉพาะลีกที่ IMPACT ผ่าน paired test**
- ถ้ายังไม่ผ่าน แต่รู้ว่าตัวหลักขาดหนัก (loss ≥ 25%) → ไม่ออก signal (`MAJOR_ABSENCE_UNMODELLED`, rules-v0.2)

## Publish (Phase 6)

```bash
npm run model:publish
```
```sql
select public_id, publish_round, home_team, away_team, kind, reason, record_hash
from published_analysis order by published_at desc;
select * from prediction_chain_daily;          -- hash ประจำวันไว้โพสต์สาธารณะ
select * from fp_verify_prediction_chain();    -- ตรวจทั้งสาย
```

- 2 รอบต่อคู่: **EARLY** (ภายใน 24 ชม. ก่อนเตะ) และ **LINEUP** (15–80 นาทีก่อนเตะ หลังรายชื่อตัวจริงออก)
- ใช้ decision ล่าสุดของ `rules-v0.2` เท่านั้น และต้องสดพอ (EARLY ≤ 4 ชม., LINEUP ≤ 75 นาที และใหม่กว่า lineup)
- 🌫️ NO_CLEAR_SIGNAL ก็ publish (นับ coverage) — เหตุผลเป็นภาษาไทยที่สร้างจากตัวเลขเท่านั้น (ไม่ใช้ LLM)
- บันทึก snapshot: ฟอร์ม 5 นัด, xG, ตัวเจ็บ, lineup, odds/การขยับราคา, API prediction, ราคาโมเดลทุกตลาด, candidate ทุกตัว
- หลัง publish แก้/ลบไม่ได้ (DB trigger + hash chain)
- `analysis_performance` แยกผลตามรอบ (`dimension = 'round'`)

## Settlement Engine (Phase 7)

```bash
npm run sync:results     # อัปเดตสกอร์นัดที่เตะแล้ว
npm run model:settle     # PENDING -> WIN / HALF_WIN / LOSS / HALF_LOSS / PUSH / VOID
```
```sql
select public_id, home_team, away_team, selection, line, status, result_score, settled_at from published_analysis order by kickoff_at desc;
select * from analysis_performance;   -- win_rate, avg_clv, beat_closing_rate แยก all / market / league / month / round
```

กฎ `settlement-v0.1` (`decideSettlement()` ใน `packages/analysis`):
- ตัดสินด้วย **สกอร์ 90 นาที** เท่านั้น (ต่อเวลา/จุดโทษไม่นับ), quarter line ได้ HALF_WIN / HALF_LOSS
- **VOID** เมื่อ: ยกเลิก/ยุติ/ตัดสินชนะบนโต๊ะ (CANC, ABD, AWD, WO) หรือไม่ได้แข่งภายใน **48 ชม.** จากเวลาเตะที่วิเคราะห์ไว้
- "ยังไม่ได้แข่ง" จะ VOID ได้ก็ต่อเมื่อข้อมูล fixture ถูก sync **หลัง** เส้นตาย 48 ชม. — sync ค้างจะไม่ทำให้ VOID ผิด ๆ
- ข้อมูลไม่ชัด (ไม่มีสกอร์ 90 นาที, ตลาดที่ไม่รู้จัก) = รอ ไม่เดา
- closing odds = median ราคาสุดท้ายก่อนเตะของแต่ละเจ้า (≥ 2 เจ้า) → `clv = odds_at_publish / closing − 1`
- DB บังคับเอง: settle ได้ครั้งเดียว, หลังจบเกมเท่านั้น, `settled_at` ใช้นาฬิกา DB, เนื้อหาบทวิเคราะห์และ hash chain ไม่เปลี่ยน

## AI Shadow Ranking (Phase 6b)

```bash
npm run model:publish
npm run model:ai-shadow     # ต้องมี ANTHROPIC_API_KEY (ไม่มี = ข้าม)
```
```sql
select * from ai_shadow_comparison;   -- กฎ vs AI บนคู่เดียวกัน: win_rate, avg_clv, agreement_rate
```

- **กฎเป็นคนเลือก 🧭** — AI จัดอันดับ candidate ชุดเดียวกันคู่ขนาน เก็บใน `ai_shadow_rankings` **ก่อนเตะ** และ**ไม่ถูก publish**
- AI เห็นเฉพาะ snapshot ตอน publish (form, xG, ตัวเจ็บ, lineup, Player Impact, API prediction, ราคาโมเดล, candidates + เหตุผลที่กฎไม่รับ) — **ไม่เห็นว่ากฎเลือกตัวไหน** เพื่อให้เป็นความเห็นอิสระ
- `claude-opus-5-5`, structured output, effort `medium`, server-side fallback เมื่อถูกปฏิเสธ — prompt version อยู่ในทุกแถว (`ai-shadow-v0.1`)
- Guard: index ต้องมีจริง, **ทุกตัวเลขในข้อความไทยต้องมาจาก input** (AI สร้างตัวเลขเองไม่ได้), ห้ามคำพนัน → ผิดกฎ = `INVALID` (เก็บไว้พร้อมเหตุผล ไม่นับในการเทียบ)
- `model:settle` ตัดสิน pick ของ AI ด้วยกฎเดียวกัน; DB บังคับ: insert ก่อนเตะเท่านั้น, เนื้อหาแก้ไม่ได้, settle ครั้งเดียว
- ต้นทุนโดยประมาณ ~2 calls ต่อคู่ (EARLY + LINEUP)

## 🔎 วิเคราะห์เกม (match preview — ทุกคู่)

```bash
npm run model:probabilities -- --days 2
npm run model:preview -- --hours 48      # มี ANTHROPIC_API_KEY = AI เรียบเรียง, ไม่มี = ข้อความจากตัวเลขล้วน
```
```sql
select fixture_id, stage, text_source, ai_status, data_support, predicted_home, predicted_away from match_previews order by kickoff_at;
select * from web_match_previews;    -- ที่เว็บแสดง: stage ล่าสุดต่อคู่
```

- **ทุกคู่** ในลีกที่ติดตามได้บทวิเคราะห์ — ไม่ใช่ pick, ไม่นับใน 🧭: ภาพรวม, มุมมองเจ้าบ้าน/ทีมเยือน, **สกอร์คาดการณ์** (scoreline ที่โมเดลให้โอกาสสูงสุด จาก score matrix เดียวกับ Probability Engine รวม cross-league blend) และหมายเหตุเรื่องข้อมูล
- 2 stage ต่อคู่: **EARLY** (ภายใน 48 ชม.) และ **LINEUP** (หลังตัวจริงออก ≤ 80 นาทีก่อนเตะ); เขียนก่อนเตะเท่านั้น (DB trigger) และแก้ไม่ได้ — ผู้อ่านเห็นข้อความเดิมเสมอ
- **Data support** ตัดสินโดยกฎ ไม่ใช่ AI (`assessDataSupport()` ใน `packages/analysis/src/preview.ts`): `GOOD` / `LIMITED` / `THIN` พร้อมเหตุผลภาษาไทย เช่น *บอลถ้วยที่ทีมมาจากคนละลีก นัดในถ้วยที่ใช้คำนวณมีเพียง N นัด*, ทีมมีข้อมูลน้อย, โมเดลยังไม่ผ่านการทดสอบ, ไม่มี xG, ไม่มีโมเดลสำหรับรายการนี้ — ช่องว่างเล็ก ๆ (ไม่มีราคา, ไม่มีรายงานตัวเจ็บ, ไม่มี H2H) บันทึกไว้แต่ไม่ลดระดับ
- AI (`claude-opus-5-5`, prompt `preview-ai-v0.2`) เห็นเฉพาะ facts ใน `facts` และ**เขียนได้แค่ร้อยแก้ว**: ตัวเลขทุกตัวต้องมาจาก input (รวมผลรวมฟอร์ม 5 นัดและเส้น O/U ที่ใส่ไว้เป็น fact), scoreline ต้องเป็นของโมเดล / ผล H2H / ผลในฟอร์มล่าสุด, ห้ามคำพนัน → ไม่ผ่าน = เก็บเป็น `INVALID` พร้อมเหตุผล แล้วใช้**ข้อความ template** (`buildTemplateText()`) แทน — ไม่มี API key ก็ได้ template เช่นกัน ดังนั้น coverage ไม่ขึ้นกับ AI
- รอบที่ AI ไม่ผ่าน (INVALID/REFUSED) ลองใหม่ได้ **อีก 1 ครั้ง** ต่อ stage: แถวเป็น append-only (ข้อความแรกยังอยู่ใน `match_previews`) เว็บแสดงแถวล่าสุด (`web_match_previews`); AI สร้างตัวเลขจากการคำนวณเอง (เช่น บวกประตู 5 นัด) ก็ถือว่าไม่ผ่าน — โดยตั้งใจ
- หน้าแมตช์แสดงการ์ด "🔎 วิเคราะห์เกม" (ป้ายระดับข้อมูล + หมายเหตุ, ข้อความ, สกอร์คาดการณ์ + ผลจริงเมื่อจบ); หน้า /today และรายการแมตช์แสดงภาพรวม 2 บรรทัด
- ต้นทุน ≈ 2 calls ต่อคู่ (EARLY + LINEUP) เหมือน shadow ranking

## ลำดับถัดไป

- **Phase 6c** ใช้ `explanation_th` ที่ผ่าน guard เป็นคำอธิบายบนเว็บ/โซเชียล (หลังดูคุณภาพจาก shadow สักระยะ)
- **Phase 8** Performance: หน้า /performance (streak, calendar, monthly report) จาก `analysis_performance` + `published_analysis`
