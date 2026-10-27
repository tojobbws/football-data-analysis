# Underdog bias — baseline (Phase 0)

วันที่ 2026-10-27 · อ้างอิงรายงาน [FA Underdog Bias Investigation — 2026-10-27](https://claude.ai/artifact/4e518MocWvJM37ceKDCWe4) · งานวิจัยนี้อ่านอย่างเดียว ไม่เปลี่ยน production

## สถานะ repository ก่อนเริ่ม

- branch `main` ที่ `18dda11` working tree สะอาด ยกเว้น `scripts/underdog-bias-report.ts` (untracked, สคริปต์ของรายงานข้างต้น)
- งานวิจัยทำบน branch `research-model-sharpness` ทุกไฟล์ใหม่อยู่ใต้ `scripts/research/` และ `docs/research/` ไม่มีไฟล์ production ถูกแก้

## Baseline ยืนยันจากข้อมูลจริง

รัน `npx tsx scripts/underdog-bias-report.ts` ซ้ำเมื่อ 2026-10-27 08:41 UTC ได้ค่าตรงกับรายงานรอบ 08:15 UTC ทุกตัว (ยังไม่มีนัดใหม่จบระหว่างสองรอบ) ผลอยู่ใน `reports/underdog-bias-2026-10-27.txt`

| ตัวชี้วัด | รายงาน | ตรวจซ้ำ |
| --- | ---: | ---: |
| นัดที่จบแล้วบนเส้น AH หลัก | 614 | 614 |
| โมเดลให้ทีมรองเฉลี่ย | 56.6% | 56.6% [55.0, 58.2] |
| ตลาดให้ทีมรองเฉลี่ย | 50.0% | 50.0% [49.9, 50.1] |
| ทีมรองเกิดจริง (fair hit) | 48.0% | 48.0% [44.1, 52.0] |
| Brier โมเดล − ตลาด | +0.0150 | +0.0150 [0.0050, 0.0249] |
| Log loss โมเดล / ตลาด | 0.7260 / 0.6918 | 0.7260 / 0.6918 |
| Log loss โมเดล − ตลาด | +0.0342 | +0.0342 [0.0118, 0.0567] |
| ทีมรอง edge 3–12 | 248 | 248 |
| ทีมต่อ edge 3–12 | 69 | 69 |
| Published AH pick ทีมรอง | 204 / 249 | 204 / 249 |

[ ] = 95% CI แบบ cluster ตามวันฟุตบอล (CR1)

## ข้อเท็จจริงจากโค้ด

### ค่าที่รายงานเดิมอ้างไม่ตรงกับ production

รายงานอ้าง `priorStrength` 3 และ half-life 240 วัน ค่านี้คือ default ของ library (`packages/analysis/src/dixon-coles.ts:62–69`) แต่ job ที่สร้างความน่าจะเป็นจริงไม่ได้ใช้

- `workers/analysis/src/jobs.ts:327–335` อ่าน config `SIDES` ล่าสุดของแต่ละลีกจาก `model_configs` ถ้ายังไม่มีจะใช้ `DEFAULT_DC` = `priorStrength` 8, `halfLifeDays` 365, `xgWeight` 0.5 (`jobs.ts:57–61`)
- config ต่อลีกมาจาก `model:tune` รายสัปดาห์ ซึ่งเลือกจาก grid `priorStrength` {3, 8, 20, 40} × `halfLifeDays` {180, 365, 730} × `xgWeight` {0, 0.5} ด้วย log loss ของ 1X2 เทียบผลจริง บน 70% แรกของประวัติลีก (`packages/analysis/src/tune.ts:125–164`) ไม่ได้เทียบกับตลาด

ค่าที่ใช้จริง ณ 2026-10-27 (`model_configs_latest`, purpose `SIDES`):

| ลีก | priorStrength | halfLifeDays | xgWeight | ลีก | priorStrength | halfLifeDays | xgWeight |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| UCL (2) | 8 | 730 | 0.5 | Allsvenskan (113) | 8 | 180 | 0.5 |
| UEL (3) | 8 | 730 | 0 | Superliga (119) | 3 | 365 | 0.5 |
| Nations League (5) | 3 | 180 | 0 | Liga Prof. Argentina (128) | 20 | 180 | 0.5 |
| Premier League (39) | 3 | 730 | 0.5 | Serie A (135) | 3 | 730 | 0.5 |
| Championship (40) | 8 | 180 | 0.5 | La Liga (140) | 3 | 365 | 0.5 |
| Ligue 1 (61) | 8 | 365 | 0.5 | Jupiler Pro (144) | 8 | 180 | 0.5 |
| Serie A BR (71) | 3 | 180 | 0.5 | Premiership (179) | 20 | 730 | 0.5 |
| Bundesliga (78) | 8 | 730 | 0.5 | A-League (188) | 8 | 180 | 0.5 |
| Eredivisie (88) | 3 | 365 | 0.5 | Süper Lig (203) | 3 | 180 | 0.5 |
| Primeira Liga (94) | 3 | 730 | 0 | Super League (207) | 20 | 730 | 0.5 |
| J1 League (98) | 40 | 730 | 0 | Bundesliga AT (218) | 20 | 730 | 0.5 |
| Eliteserien (103) | 3 | 180 | 0.5 | MLS (253) | 8 | 180 | 0.5 |
| Liga MX (262) | 3 | 365 | 0.5 | K League 1 (292) | 40 | 180 | 0 |
| Thai League 1 (296) | 8 | 365 | 0 | Pro League (307) | 3 | 365 | 0.5 |
| UECL (848) | 8 | 730 | 0.5 | | | | |

config ถูก tune ใหม่ทุกสัปดาห์ (ล่าสุด 2026-10-25/26) ค่าจึงเปลี่ยนตามเวลา M0 ในงานนี้คือค่าชุดนี้

### โมเดลที่สร้างความน่าจะเป็น AH

- Dixon-Coles: λ = c · attack[home] · defence[away] · homeAdv, μ = c · attack[away] · defence[home] พร้อม τ แก้สกอร์ต่ำ (`dixon-coles.ts:1–13`)
- **priorStrength k** (`dixon-coles.ts:139–158`): attack = (ประตูที่ทำได้ + k) / (ประตูที่คาด + k) จึงเพิ่มประตูเสมือน k ลูกทั้งเศษและส่วน ดึงทุกทีมเข้าหา 1.0 ทีมที่ข้อมูลน้อยถูกดึงมากกว่า k ยิ่งมาก ความต่างระหว่างทีมยิ่งแคบ ความน่าจะเป็นยิ่งแบน
- **halfLifeDays** (`dixon-coles.ts:86–100`): น้ำหนักแมตช์ = exp(−ln2 · อายุ / half-life) half-life สั้นทำให้ข้อมูลที่มีผลน้อยลง prior จึงมีน้ำหนักมากขึ้นโดยอ้อม
- **xgWeight**: ประตูที่ใช้ fit = w · xG + (1 − w) · ประตูจริง เมื่อมี xG ทั้งสองทีม
- ทุกลีกถูก fit จากแมตช์ของลีกนั้นเท่านั้น (`jobs.ts:317, 335`)
- **ถ้วยยุโรป** (UCL, UEL, UECL): score matrix = 0.5 × cup-only DC + 0.5 × cross-league model (`jobs.ts:46, 340–374`) cross-league ใช้ความแข็งแกร่งภายในลีกบ้านของแต่ละทีม (fit ทั้ง 55 ลีกใน `UEFA_DOMESTIC`) คูณกับ offset ของลีกที่เรียนจากแมตช์ถ้วย และมี prior 4 (`packages/analysis/src/cross-league.ts:48–143`) การผสม distribution สองชุดแบบเชิงเส้นให้ distribution ที่แบนกว่าแต่ละชุดเสมอ
- **Elo** ใช้กับ 1X2 ใน ensemble และ Elo agreement ใน candidate เท่านั้น ไม่เข้า AH หรือ O/U
- **O/U** ใช้ fit แยก (`TOTALS`) + `totalsShrink` ที่ดึงผลรวมประตูเข้าหาค่าเฉลี่ยลีก (`dixon-coles.ts:248`, `jobs.ts:375`)
- **Player Impact**: candidate ปรับ λ/μ ตามผู้เล่นที่ขาด (`modelSource` = `DC+IMPACT`) งานนี้วัดเฉพาะ DC sides ซึ่งเป็นแหล่งของความเอียง

### ตลาดและการ settle

- Consensus: de-vig แบบ proportional ต่อเจ้ามือ แล้วใช้ median ข้ามเจ้ามือ (`packages/analysis/src/candidates.ts:273`)
- เส้นหลัก: ≥ 3 เจ้ามือที่สด (≤ 12 ชม.) และใกล้ 50/50 ที่สุด ห่างไม่เกิน 15 จุด (`candidates.ts:534`)
- Settlement และ fair target: `settle` / `settleAsian` (`packages/analysis/src/settlement.ts`) และ `fairTarget` (`packages/analysis/src/evaluation.ts:22`) — WIN 1, HALF_WIN ½ น้ำหนัก y = 1, HALF_LOSS ½ น้ำหนัก y = 0, PUSH ไม่นับ

## ชุดข้อมูล

| ชุด | ใช้ทำอะไร | Match ID | Kickoff | เวลาทำนาย | เวลาของราคา | ผล |
| --- | --- | --- | --- | --- | --- | --- |
| `fixtures` + `fixture_statistics` (xG) + `fixture_events` (ใบแดง) | fit โมเดล | มี | มี | — | — | 90 นาที (`ft_*` ก่อน, ไม่มีจึงใช้ `goals_*`) |
| `external_odds` PIN (football-data) | ตลาดอ้างอิงย้อนหลัง | มี | จาก fixture | — | **ไม่มีเวลาจริง** มีเพียง phase `early` / `close` | — |
| `market_closing` | ตลาดปิดของระบบเอง (live) | มี | มี | `analysis_run_id` | `closing_at`, `recorded_at` | — |
| `analysis_runs` / `analysis_candidates` | baseline live | มี | จาก fixture | `started_at` | `oddsUpdatedAt` ใน `factors` | — |

ตรวจแล้ว:

- PIN ใน `external_odds` มี 18,000 fixture ทุกนัดจบแล้วและมีสกอร์ครบ
- เส้น AH ของ PIN: AWAY = −HOME ทุกแถว (early 9,369, close 9,384, ไม่มีแถวผิด)
- ครอบคลุม: AH และ O/U มี 11 ลีก ช่วง 2023-07-27 ถึง 2026-01-14; 1X2 มี 19 ลีก ถึง 2026-10-13
- ไม่มีราคาถ้วยยุโรปย้อนหลัง ราคาถ้วยมีเฉพาะ `market_closing` 108 นัด (2026-10-12 ถึง 2026-10-21)
- ประวัติ fixture ของลีกส่วนใหญ่เริ่ม 2023-08 จึงมีข้อมูลราว 3 ฤดูกาล

## ข้อจำกัดที่กำหนดวิธีวิจัย

1. ราคา `early` ของ football-data ไม่มี timestamp โดยทั่วไปเก็บ 1–3 วันก่อนเตะ งานนี้จึง fit โมเดลจากแมตช์ที่เตะก่อนเวลาแข่ง **3 วัน** เท่านั้น เพื่อไม่ให้โมเดลรู้ผลที่ตลาด early ยังไม่รู้ ซึ่งทำให้โมเดลเสียเปรียบเล็กน้อยเมื่อเทียบราคาปิด
2. ข้อมูล 3 ฤดูกาล + burn-in 365 วัน ทำให้ช่วงวัดผลราว 2024-08 ถึง 2026-01 (AH) half-life 1,095 วันจึงแทบเท่ากับไม่ decay ภายในข้อมูลที่มี
3. M0 ใช้ค่าที่ tune ด้วยข้อมูลถึงเดือนตุลาคม 2026 ซึ่งครอบคลุมช่วงวัดผล M0 จึงได้เปรียบจากการเลือกด้วยข้อมูลเดียวกันบางส่วน ถ้า candidate ชนะ M0 ได้ หลักฐานจึงยิ่งหนักแน่น
4. ถ้วยยุโรปไม่มีราคาตลาดย้อนหลัง Experiment C จึงวัดกับผลจริงเป็นหลัก และเทียบตลาดได้แค่ 108 นัดล่าสุด

## คำสั่งทำซ้ำ

```
npx tsx scripts/underdog-bias-report.ts                 # baseline live (reports/underdog-bias-<date>.txt/.json)
npx tsx scripts/research/sharpness-experiment.ts        # การทดลอง M0–M4 (reports/sharpness-<date>.txt/.json)
npx vitest run scripts/research/sharpness.test.ts       # tests ของ harness
```
