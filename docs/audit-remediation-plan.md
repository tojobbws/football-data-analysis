# Audit remediation plan

แผนแก้ตามรายงาน "FA Prediction Engine Audit — 2026-10-26" (Claude Doc: https://claude.ai/artifact/UbbGifN1YHNYHKqXN3F3rH)
Branch `audit-remediation` จาก `main` @ `dcaff1c` · เริ่ม 2026-10-26

## Baseline (วัดใหม่ 2026-10-26 จาก DB production แบบ read-only)

ตัวเลขทั้งหมดใน audit ทำซ้ำได้ตรง ไม่มีค่าที่ต่างจากรายงาน

| ตัวชี้วัด | ค่า | ชุดข้อมูล |
| --- | --- | --- |
| 1X2 Brier โมเดล / ตลาด | 0.5864 / 0.5632 | 613 นัด, 20 วันฟุตบอล; โมเดล = snapshot สุดท้ายก่อนเตะของ `dixon-coles-v0.2`, ตลาด = `market_closing` 1X2 |
| 1X2 log loss โมเดล / ตลาด | 0.9868 / 0.9520 | ชุดเดียวกัน |
| AH เส้นหลักตอนเตะ Brier (fair target) โมเดล / ตลาด | 0.2640 / 0.2492 | 604 นัด (push 40), ฝั่ง HOME; โมเดล = `market_closing.model_probability` |
| O/U เส้นหลักตอนเตะ Brier (fair target) โมเดล / ตลาด | 0.2637 / 0.2498 | 609 นัด (push 29), ฝั่ง OVER; โมเดลให้ OVER เฉลี่ย 44.4% ตลาด 50.1% ผลจริง 53.2% |
| Pick ทุกแถว | 300 SIGNAL: W116 HW8 P37 HL10 L120 V3 pending 6; fair hit 0.4898; CLV n=294 mean +0.00160 sd 0.0636 | `analysis_predictions` |
| Pick 1 ต่อนัด (SIGNAL ล่าสุด) | 290 SIGNAL: W111 HW8 P36 HL10 L116 V3 pending 6; fair hit 0.4873; CLV n=284 mean +0.00288 | |
| Pick: ความน่าจะเป็นโมเดลเทียบตลาดบนฝั่งที่เลือก (ณ เวลา publish) | Brier 0.2440 / 0.2337; โมเดลเฉลี่ย 57.7% ตลาด 49.2% ผลจริง 48.7% | 245 pick ที่ตัดสินได้ |
| Coverage ตั้งแต่ 2026-10-16 | 489 นัดจบ: มี snapshot 489, มีตลาด 1X2 489, มีคู่ AH 485 | ลีกที่มี `model_configs` |
| Tests | 45 ไฟล์ 433 tests ผ่าน | PGlite in-memory |

Fair target (ใช้ทั้งระบบ): WIN = น้ำหนัก 1, ผล 1 · HALF_WIN = น้ำหนัก ½, ผล 1 · HALF_LOSS = น้ำหนัก ½, ผล 0 · LOSS = น้ำหนัก 1, ผล 0 · PUSH/VOID ไม่นับ
ค่าเฉลี่ยถ่วงน้ำหนักของผลเท่ากับสูตร fair hit (W + ½HW) / (W + L + ½(HW + HL)) และเป็น proper scoring rule ของ fair probability ซึ่งตลาดแบบ no-vig ก็หมายถึงค่าเดียวกัน

## ผล gate เทียบตลาด (`reports/market-gate-2026-10-26.txt`)

Walk-forward Dixon-Coles แบบ untuned เทียบ Pinnacle (football-data) บน target เดียวกัน, CI 95% cluster ตามวันฟุตบอล, Holm ข้ามทุก test ของแต่ละ phase

| Phase | ตลาด | n · วัน | Brier โมเดล / ตลาด | ส่วนต่าง (95% CI) | ผล |
| --- | --- | --- | --- | --- | --- |
| early | 1X2 | 6,256 · 391 | 0.5896 / 0.5768 | +0.0128 (+0.0102 .. +0.0154) | ตลาดแม่นกว่า |
| early | AH เส้นหลัก | 5,150 · 337 | 0.2569 / 0.2493 | +0.0076 (+0.0052 .. +0.0100) | ตลาดแม่นกว่า |
| early | O/U 2.5 | 5,489 · 340 | 0.2438 / 0.2406 | +0.0031 (+0.0016 .. +0.0047) | ตลาดแม่นกว่า |
| close | 1X2 | 11,393 · 621 | 0.6043 / 0.5904 | +0.0139 (+0.0117 .. +0.0161) | ตลาดแม่นกว่า |
| close | AH เส้นหลัก | 5,158 · 338 | 0.2583 / 0.2495 | +0.0087 (+0.0062 .. +0.0113) | ตลาดแม่นกว่า |
| close | O/U 2.5 | 5,505 · 339 | 0.2438 / 0.2395 | +0.0044 (+0.0026 .. +0.0061) | ตลาดแม่นกว่า |

- ต่อลีกหลัง Holm ไม่มีลีกใดที่โมเดลแม่นกว่า; AH ส่วนใหญ่ "ยังแยกไม่ออก" เพราะ n ต่อลีก 300–600 ไม่พอ ไม่ใช่เพราะโมเดลเท่าตลาด
- ฝั่งที่กฎ pick เลือกได้ (โมเดลสูงกว่าตลาด 3–12 จุด, early): AH 2,859 ฝั่ง โมเดลให้ 56.6% ตลาด 50.0% เกิดจริง 50.2% (48.2–52.1%); O/U 2.5 2,870 ฝั่ง 53.8% / 47.9% / 47.2%
- ตลาดเรียง calibration ได้ดี ส่วนต่างของโมเดลเป็นความมั่นใจเกินจริง ไม่ใช่ข้อมูลที่ตลาดไม่มี
- ข้อจำกัด: O/U มีเฉพาะเส้น 2.5 ใน football-data; 21 ลีกที่มีราคา; ไม่มี UCL/UEL/UECL/UNL, Thai L1, K League, A-League, ASEAN

## ผลทดลอง calibration / market blend (`reports/calibration-experiment-2026-10-26.txt`)

AH เส้นหลักและ O/U 2.5 (football-data PIN), walk-forward รายเดือน 10 เดือน แล้ว final holdout 20% ล่าสุดของวันแข่ง (936–1,016 นัด) ใช้ครั้งเดียว

| Phase · ตลาด | Brier holdout: โมเดล / ตลาด | น้ำหนักโมเดลใน blend ที่ walk-forward เลือก | temperature b | ฝั่ง edge 3–12 ใน holdout: โมเดล / ตลาด / เกิดจริง |
| --- | --- | --- | --- | --- |
| early · AH | 0.2569 / 0.2498 | 0–0.05 (final 0) | 0.2 (ขอบล่างของ grid) | 56.6% / 50.0% / 47.4% (n 535) |
| early · O/U 2.5 | 0.2451 / 0.2427 | 0 | 0.85 | 53.6% / 47.8% / 47.3% (n 467) |
| close · AH | 0.2571 / 0.2509 | 0 | 0.2 (ขอบล่าง) | 56.7% / 49.9% / 48.0% (n 553) |
| close · O/U 2.5 | 0.2464 / 0.2427 | 0 | 0.85 | 52.7% / 46.8% / 47.0% (n 543) |

ข้อสรุป: ทุกวิธีที่ fit จากข้อมูลก่อนหน้าเลือก "ใช้ตลาดล้วน" (น้ำหนักโมเดล 0) จึงไม่มี blend ใดดีกว่าตลาด ส่วน calibration แบบ temperature บน AH ดันโมเดลจนเกือบ 50/50 ทุกนัด หมายความว่าโมเดลแทบไม่มีข้อมูลเรื่อง AH ที่ตลาดไม่มี ตามกฎที่ตั้งไว้ก่อน (ใช้ blend เมื่อดีกว่านอกชุดฝึก) **ไม่นำ blend หรือ calibration เข้า production** และคงโมเดลเดิม ถ้าใช้ความน่าจะเป็นที่ calibrate แล้ว edge ของ pick จะหายไปเกือบทั้งหมด จึงเป็นข้อมูลสำหรับการตัดสินใจ D1 ไม่ใช่การแก้ที่ทำได้เอง

## ยังไม่ได้ทำ

| Finding | เหตุผล / ข้อเสนอ |
| --- | --- |
| A-14 neutral venue | เปลี่ยนความน่าจะเป็นใน production ต้องมี backtest ก่อน: ยังไม่มีคอลัมน์สนามกลางใน `fixtures` (มีเฉพาะ `competition_rules` ของถ้วย) |
| A-16 horizon / scoreline log loss / O/U calibration บนเว็บ | ทำได้หลัง 0043 ใช้งาน: view สกอร์จาก `scoreline_snapshots` และ snapshot ตาม T-24h/T-6h/T-1h |
| A-17 streak จาก 200 แถว | ย้ายไปคำนวณใน SQL ต่อแมตช์ |
| A-19 α ของ Impact แยกตามแหล่งข้อมูล | เปลี่ยนโมเดล ต้อง backtest |
| A-20 odds = 1.000 | consensus กรองอยู่แล้ว; ถ้าจะกรองตอน parse ต้องตัดสินว่าเก็บข้อมูลดิบหรือไม่ |
| A-12 | ไม่มีโค้ดให้แก้: เป็นกติกาการทำงาน ทุกการเปลี่ยน `DEFAULT_RULES` ควรผ่าน shadow trial (ADR 0003) |
| live worker 429 | rate limit ต่อนาทีจาก egress IP ร่วมของ Cloudflare ไม่กินโควตา และ settle ใช้ `sync:results` รายชั่วโมง กระทบเฉพาะความสดของสกอร์สด แก้ได้ด้วย egress ที่ต่างออกไป (นอกขอบเขต) |

## Root cause เพิ่มจาก audit

- **A-07 (ลดระดับ)** timestamp ของ odds เป็นระดับ fetch แต่ `insertOddsHistory` เก็บราคาเดิมซ้ำทุก 6 ชม. (heartbeat) ดังนั้นแถวล่าสุดของแต่ละเจ้ามือมี stamp ไม่เก่ากว่า ~6 ชม. ตราบที่เจ้ามือยังอยู่ใน response เจ้ามือที่หายไปจะถูกตัดด้วยกฎ 12 ชม. ได้ ส่วนเจ้ามือที่ยังอยู่แต่ราคาค้างฝั่งต้นทาง API-Football ไม่มีข้อมูลให้ตรวจ แก้ได้เพียงลด `maxOddsAgeHours` (เปลี่ยนกฎ pick จึงต้องอนุมัติ)
- **A-23 (ใหม่)** `model:tune` รายสัปดาห์รันใน job ที่ timeout 30 นาที แต่ tune ทุกลีกใช้นานกว่านั้น: run 2026-10-19 23:29 UTC ถูกตัดกลางทาง (sync_runs ค้าง RUNNING, บางลีกได้ config ใหม่บางลีกไม่ได้) และ health check พบว่า tune สำเร็จครั้งล่าสุด 2026-10-16 · แก้แล้ว: แยกเป็น job `tune` timeout 120 นาที


- **A-21** `scripts/backtest-vs-market.ts:72` ให้คะแนน HALF_WIN = 0.75, HALF_LOSS = 0.25 ซึ่งไม่ใช่ target ของ fair probability (ค่าคาดหวังของมันไม่เท่ากับ p) การเทียบสองฝั่งยังยุติธรรมเพราะใช้คะแนนเดียวกัน แต่ Brier ที่รายงานไม่ใช่ proper score ของความน่าจะเป็นที่ระบบใช้
- **A-22** AH/O-U ที่ `market_closing` เก็บ model probability ของเส้นหลักไว้แล้ว (run สุดท้ายก่อนเตะ) จึงเทียบโมเดลกับตลาดบนเส้นเดียวกันได้ทันทีโดยไม่ต้องรอ point-in-time reader

## ลำดับงาน

| ลำดับ | Findings | งาน | สถานะ |
| --- | --- | --- | --- |
| 1 | A-01, A-02, A-04 | `packages/analysis/src/evaluation.ts`: fair target, weighted Brier/log loss, mean แบบ cluster ตามวันฟุตบอล + CI, Holm, verdict ที่มี `INSUFFICIENT_EVIDENCE` | เสร็จ |
| 2 | A-02, A-04 | `scripts/market-gate-report.ts` (+ `scripts/market-rows.ts`): walk-forward เทียบ Pinnacle ต่อลีก ต่อตลาด บน target เดียวกัน, Holm, verdict — report-only ไม่แตะ `enabled` | เสร็จ |
| 3 | A-03, A-09 | migration 0043: view `web_benchmark_days`, `analysis_performance_by_match`; `/performance` แสดงตลาด, CI, coverage, calibration โดยรวม, สถานะ; KPI นับ 1 ต่อแมตช์ | เสร็จ (รอ migrate) |
| 4 | A-06 | migration 0043: `fp_admin_review()` สูตร fair hit ถูก + `fair_n`; test HALF; admin lower bound ใช้ `fair_n` | เสร็จ (รอ migrate) |
| 5 | A-08 | `latestQuotes` / `latestProbabilities` / `latestModelConfigs` รับ `asOf`; `consensus()` ไม่รับ quote จากอนาคต; `candidateContext(..., { pointInTime })`; `reanalyze-today.ts` ใช้ point-in-time; replay test | เสร็จ |
| 6 | A-05 | `tuneLeague({ frozenFrom })` + `model:tune --frozen-from`; Holm ข้ามลีกพิมพ์ท้าย job (`enabled` ไม่เปลี่ยน) | เสร็จ (เปิดใช้ frozen holdout = D2) |
| 7 | A-11, A-23 | workflow: ขั้นรายชั่วโมง/รายวันทำต่อเมื่อขั้นก่อนล้มแล้วรายงานท้าย run; tune แยก job 120 นาที; `model:health` รายวัน (ล้ม = อีเมลจาก GitHub); ปิด run ค้าง RUNNING > 120 นาที | เสร็จ |
| 8 | A-13, A-15 | `inputs.trainingHash` (sha256 ของข้อมูลที่ fit เห็น), `inputs.totalsRho` | เสร็จ |
| 9 | — | `scripts/calibration-experiment.ts`: blend / calibration แบบ walk-forward + final holdout | เสร็จ (ผลด้านล่าง) |
| 10 | A-18 | migration 0044: materialize `web_model_result_rows` (ฐานของผลโมเดล, calibration, benchmark) และ `web_model_outlook_performance`; job `model:refresh-web` รายชั่วโมง/รายวันหลัง closing; health เฝ้า job นี้ · วัดบน prod ก่อนแก้: `web_model_results` 4.7 วิ ตอน cache เย็น (anon timeout 3 วิ) | เสร็จ |
| 11 | A-14, A-16, A-17, A-19, A-20 | ดู "ยังไม่ได้ทำ" | ค้าง |

## การตัดสินใจที่ต้องให้เจ้าของอนุมัติ (ยังไม่ทำ)

- **D1 อนาคตของเข็มทิศเกม (A-01)**: (ก) ย้ายเป็น shadow จน gate เทียบตลาดผ่าน (ข) ใช้ความน่าจะเป็นที่ผสมตลาดแทน edge ดิบ — ผลทดลองบอกว่าน้ำหนักที่ดีที่สุดของโมเดลคือ 0 จึงแทบไม่เหลือ pick (ค) คงเดิมแต่แสดงผลเทียบตลาดบน /performance (ทำแล้วใน Phase 1) (ง) เปลี่ยนบทบาทเข็มทิศเกมจาก "มองต่างจากตลาด" เป็นการอธิบายเกมโดยอิงตลาด แล้วให้โมเดลพิสูจน์ตัวเองใน shadow
- **D2 ต่อ gate เทียบตลาดเข้ากับ `enabled`**: ต้องเลือกเกณฑ์ก่อน "ต้องดีกว่าตลาด" จะปิดทุกลีก (ไม่มีลีกใดผ่าน) ส่วน "ห้ามแย่กว่าตลาด" จะผ่านหลายลีกเพียงเพราะ n ต่อลีกน้อย ทั้งที่รวมทุกลีกตลาดแม่นกว่าชัดเจน; ลีกที่ไม่มีราคาย้อนหลัง 9 รายการต้องมีกติกาแยก และ CONTEXT.md นิยาม benchmark forecast ว่าไม่ป้อนกฎ pick จึงต้องแก้นิยามด้วย
- **D4 frozen holdout**: เปิด `model:tune --frozen-from <วันที่>` ใน workflow หรือไม่ (จะทำให้ holdout ของ gate หยุดเลื่อนทุกสัปดาห์)
- **D3 หน่วยนับ pick**: Phase 1 ใช้ SIGNAL ล่าสุดของแต่ละนัด (pick ที่หน้าแมตช์แสดงล่าสุด) เป็นตัวเลขหลัก ส่วน "แยกตามรอบ" ยังนับทุกรอบ

## Acceptance criteria

Phase 1
- โมเดลกับตลาดถูกให้คะแนนบน target เดียวกัน (1X2 กับ 1X2, AH/O-U บนเส้นและฝั่งเดียวกันด้วย fair target)
- Settlement ทุกผล (WIN, HALF_WIN, PUSH, HALF_LOSS, LOSS, VOID) มี test; SQL settlement ตรงกับ `settleAsian` ทุกกรณีที่ทดสอบ
- `/performance` แสดงตลาด, ส่วนต่าง, 95% CI แบบ cluster ตามวันฟุตบอล, จำนวนนัด/วัน และ coverage; ข้อมูลไม่พอแสดง "ข้อมูลยังไม่พอสรุป"
- ไม่มีการแก้ prediction, pick หรือ settlement เดิม; ไม่เปลี่ยน gate หรือการ publish
- `fp_admin_review()` ให้ fair hit เท่ากับ `analysis_performance` บนชุดเดียวกัน

Phase 2
- Replay ณ เวลา T อ่าน quote ที่ `collected_at > T` ไม่ได้ (test)
- Final holdout แยกจากการปรับ และบันทึกช่วงเวลา/เวอร์ชัน

## Migration

- `supabase/migrations/20261026000043_market_benchmark.sql` — รันแล้ว 2026-10-26 · ตรวจบน prod: ทุกค่าตรง baseline · rollback: `supabase/rollbacks/0043_rollback.sql`
- `supabase/migrations/20261026000044_model_results_materialized.sql` — รันแล้ว 2026-10-26 · หลังรัน: `web_model_results` 94 ms, `web_model_calibration` 18 ms, `web_model_outlook_performance` 1 ms (เดิม 4.7 วิตอน cache เย็น) · rollback: `supabase/rollbacks/0044_rollback.sql`
- `supabase/migrations/20261026000045_benchmark_materialized.sql` — รันแล้ว 2026-10-27 · `web_benchmark_days` ยังใช้ 3.8 วิตอน cache เย็นหลัง 0044 (0.14 วิตอนอุ่น) จึง materialize ด้วย และกำหนด `search_path` ให้ฟังก์ชัน settlement ของ 0043 เพราะ Postgres 17 (prod 17.11) สร้าง/refresh materialized view ด้วย search_path แบบปลอดภัย · หลังรัน: 34 ms, ค่าตรงเดิม (1X2 613 นัด Brier 0.5864/0.5632) · rollback: `supabase/rollbacks/0045_rollback.sql` (ทดสอบบน PGlite แล้ว)
- `supabase/migrations/20261027000046_odds_movement_pushdown.sql` — ยังไม่รัน · ดู "Incident 2026-10-27" · rollback: `supabase/rollbacks/0046_rollback.sql` (ทดสอบบน PGlite แล้ว)

## Incident 2026-10-27: job preview / odds ล้มทุกชั่วโมง

- อาการ: ตั้งแต่ 2026-10-26 18:05 UTC job `preview` ใช้ 7–20 นาที (เดิม 6–8 วิ) แล้วตั้งแต่ 02:05 UTC ล้มด้วย statement timeout ที่ `Repository.selectionMovement` ทุกชั่วโมง; job `odds` ที่รันคู่กันช้าจนถูก job limit 30 นาทีตัด (03:05 ค้าง RUNNING จน `abandonStaleRuns` ปิด) ขั้นหลัง odds ในรอบรายชั่วโมงจึงไม่ได้รัน
- สาเหตุ: view `odds_movement` (0002) จัดอันดับทุก quote ใน CTE ที่ join กับตัวเอง CTE ที่ใช้สองครั้งถูก materialize เงื่อนไข `fixture_id = $1` จึงเข้าไปไม่ถึง ทุกครั้งที่เรียก = Seq Scan + sort `odds_history` ทั้ง table (3.26 ล้านแถว, 439 MB; `work_mem` 2 MB → sort ลง disk; `temp_bytes` สะสม 1,366 GB) โตจนเกิน RAM ของ instance (`shared_buffers` 224 MB, DB 2.45 GB)
- ไม่เกี่ยวกับ 0044/0045: 0044 รัน 11:43 UTC และ preview ยังเร็วถึง 17:05 UTC; 0045 รันหลังเริ่มล้ม
- แก้: 0046 เขียน view ใหม่ (คอลัมน์และแถวเท่าเดิม) ให้ filter `fixture_id` ลงไปถึง index key ของ `odds_history` · ตรวจบน prod แบบ read-only (fixture 1494328): plan ใช้ `Index Cond: (fixture_id = …)` และผลทุกตลาดตรงกับ logic เดิม; test ใน PGlite ยืนยันว่า view เดิมไม่ผ่าน plan test นี้
