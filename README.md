# Football Data & Analysis Platform

> **Data → Analysis → Decision → Content → Result → Track Record → Trust**
>
> บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้

สถานะ: **Phase 1–6 เสร็จ** (Data Engine + Database + Odds History + Probability Engine + Candidate Generator) และวาง schema ของ Track Record แบบแก้ไม่ได้ไว้แล้ว

## โครงสร้าง

```text
football-platform/
├── apps/web/                 Next.js + TS + Tailwind (placeholder — UI คือ Phase 9)
├── packages/
│   ├── shared/               env (zod), logger, league ids, time utils
│   ├── football/             API-Football client + typed endpoints + mappers + odds parser
│   ├── database/             pg/Supabase access, upsert helpers, Repository, migrations runner
│   └── analysis/             settlement rules, Dixon-Coles, Elo, market pricing, metrics, backtest
├── workers/
│   ├── football-sync/        leagues, teams, fixtures, details, lineups, injuries, predictions, standings, players
│   ├── odds-sync/            odds snapshots -> odds_history
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
| `sync:lineups [--minutes]` | ตัวจริงก่อนเตะ | ทุก 15–60 นาที |
| `sync:injuries [--days]` | ตัวเจ็บ | วันละครั้ง |
| `sync:predictions [--hours]` | API Prediction (เก็บเป็น snapshot, เป็นแค่ 1 input) | วันละครั้ง |
| `sync:standings` | ตารางคะแนน | วันละครั้ง |
| `sync:players` | สถิตินักเตะทั้ง season (หลาย page) | สัปดาห์ละครั้ง |
| `sync:odds` | odds → `odds_history` (append-only) | ชั่วโมงละครั้ง / ถี่ขึ้นใกล้เตะ |

ทุก job บันทึก `sync_runs` (จำนวน request ที่ใช้ = ต้นทุน API) และทุก response ถูกเก็บดิบใน `api_raw_responses` ก่อน process เสมอ
**Free plan ของ API-Football มี quota ต่อวันจำกัด** — พอสำหรับพัฒนา แต่ถ้ารัน odds ทุกชั่วโมงจริงต้องใช้ plan แบบจ่ายเงิน (ดู request ที่ใช้จริงได้จาก `select job, sum(requests_used) from sync_runs group by 1`)

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

## ลำดับถัดไป

- **Phase 6b** AI layer: อธิบายภาษาไทย + มีสิทธิ์ลดเป็น 🌫️ เท่านั้น (ไม่สร้างตัวเลขเอง)
- **Phase 7** Settlement Engine — ใช้ `settle()` ใน `packages/analysis` (รองรับ quarter line แล้ว) + closing odds/CLV จาก `odds_closing`
