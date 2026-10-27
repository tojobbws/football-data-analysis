# Underdog bias — ข้อเสนอแนะ

วันที่ 2026-10-27 · ผล: [underdog-bias-results.md](underdog-bias-results.md)

## คำแนะนำ

**คง M0 ไว้ ไม่เปลี่ยน production** ไม่มี candidate ที่ผ่านเกณฑ์ที่ตั้งไว้ก่อนรัน การเปลี่ยน `priorStrength` หรือ `halfLifeDays` ทั้งระบบไม่ทำให้ความน่าจะเป็นแม่นขึ้น แม้ prior ต่ำจะลดความเอียงไปทางทีมรองได้เกือบครึ่ง การลดความเอียงโดยไม่ได้ความแม่นเพิ่ม ไม่ถือเป็นการปรับปรุงตามหลักของงานนี้

ช่องว่างกับตลาดเป็นเรื่องข้อมูลที่โมเดลไม่มี ไม่ใช่การตั้งค่า การแก้ที่ค่าพารามิเตอร์จึงไม่ปิดช่องว่างนี้

## Candidate แต่ละตัว

| Candidate | ข้อดี | ข้อเสีย | ความไม่แน่นอน | สถานะ |
| --- | --- | --- | --- | --- |
| M1 prior 1 | คมขึ้น, calibration slope ≈ 1, เอียงลด 3.4 → 1.9 จุด | Brier/log loss ไม่ดีขึ้น; Brier O/U แย่ลง +0.0012 [0.0003, 0.0021] | ผลต่างบน AH ±0.001 | ไม่ผ่าน |
| M1 prior 3 | เท่ากับ M0 | ไม่ดีขึ้น | — | ไม่ผ่าน |
| M1 prior 8 / 20 | — | แย่กว่า M0 (20 อย่างมีนัยสำคัญ) | — | ไม่ผ่าน |
| M2 half-life ทุกค่า | — | ไม่ดีขึ้น; 120 วันแย่กว่า | — | ไม่ผ่าน |
| M3 cross-league only (ถ้วย) | Holdout log loss −0.026 [−0.036, −0.016]; live เอียงลด 11.3 → 7.9 จุด | Dev ไม่ต่างจาก production; ยังแพ้ตลาด | เลือกจาก holdout จะ overfit | ไม่ผ่าน (รอยืนยัน) |
| M3 mix 0.25 (ถ้วย) | Holdout −0.016 [−0.021, −0.012] | Dev Holm p 0.14 | เช่นเดียวกัน | ไม่ผ่าน (รอยืนยัน) |
| M4 | — | ไม่ได้สร้าง | — | — |

## ขั้นตอนถัดไปที่ต้องได้รับอนุมัติ

เรียงจากเสี่ยงน้อยไปมาก ทุกข้อยังไม่ได้ทำ

1. **ยืนยัน M3 กับแมตช์ใหม่ (forward test):** ตรึงน้ำหนัก 0 และ 0.25 ไว้ตอนนี้ แล้วรัน `scripts/research/sharpness-experiment.ts` ซ้ำกับแมตช์ถ้วยตั้งแต่ 2026-10-28 เป็นต้นไป เกณฑ์ตั้งไว้ก่อน: อย่างน้อย 150 นัด, log loss 1X2 เทียบ production มีขอบบน 95% CI < 0 และ Brier AH เทียบราคาปิดของระบบไม่แย่กว่า production งานนี้อ่านอย่างเดียว ไม่ต้องมี migration ในฤดูกาลปกติจะได้ 150 นัดในราว 4–6 สัปดาห์
2. **หาสาเหตุที่ live เอียงสองเท่าของข้อมูลย้อนหลัง:** รัน walk-forward กับนัด live ของเดือนตุลาคมโดยแยกถ้วยกับลีก และแยก Player Impact ออก งานวิจัย อ่านอย่างเดียว
3. **O/U แยกเรื่อง:** ตรวจ fit `TOTALS` และ `totalsShrink` ซึ่งเป็นกลไกคนละตัวกับ sides ก่อนสรุปเรื่องสัดส่วน Under ต่อ Over
4. **การตัดสินใจของเจ้าของที่ค้างอยู่ (D1, D2):** หลักฐานรอบนี้เสริมว่าโมเดลแพ้ตลาดในทุก config ที่ทดลอง เกณฑ์ edge 3–12 จุดจึงยังเลือกจากความต่างที่มาจากโมเดลเป็นหลัก การเปลี่ยนบทบาทเข็มทิศเกม หรือการต่อ gate เทียบตลาด เป็นการตัดสินใจระดับ product
5. **ข้อมูลที่โมเดลขาด:** ถ้าจะปิดช่องว่างกับตลาดจริง ต้องเพิ่ม input (เช่น ตัวจริงที่ยืนยันแล้ว หรือ xG ที่น้ำหนักต่างกัน) และทดสอบด้วย harness เดียวกัน เป็นงานวิจัยรอบใหม่ ต้องกำหนดขอบเขตก่อน

ถ้าวันหนึ่ง candidate ผ่าน จะเสนอแผนนำเข้า production แยกต่างหาก ระบุไฟล์ที่เปลี่ยน (`workers/analysis/src/jobs.ts` สำหรับ `CROSS_LEAGUE_BLEND` หรือ grid ของ tuner), ผลต่อ pick, test, การ rollback และการเฝ้าระวัง แล้วรออนุมัติ

## ผลกระทบที่คาดไว้หากนำ M3 cross-league only มาใช้ในอนาคต (ยังไม่ทำ)

- ถ้วยยุโรปจะเอียงไปทางทีมรองน้อยลง (live 11.3 → 7.9 จุด) pick ทีมรองในถ้วยจะลดลง
- ยังแพ้ตลาด จึงไม่ได้ทำให้ pick มีความได้เปรียบ
- เสี่ยงว่าผล holdout ที่ดีเป็นเรื่องบังเอิญของช่วง 2026-05 ถึง 2026-10 จึงต้องผ่านข้อ 1 ก่อน

## ไฟล์

**เพิ่ม** (branch `research-model-sharpness`)

- `scripts/underdog-bias-report.ts` — รายงาน baseline live (อ่านอย่างเดียว)
- `scripts/research/sharpness.ts` — walk-forward, ตัวชี้วัด, กฎเลือก
- `scripts/research/sharpness.test.ts` — 15 tests
- `scripts/research/sharpness-experiment.ts` — runner (อ่านอย่างเดียว)
- `docs/research/underdog-bias-baseline.md`, `-experiments.md`, `-results.md`, `-recommendation.md`
- `reports/sharpness-2026-10-27.*`, `reports/underdog-bias-2026-10-27*.*` (gitignored)

**ไม่ได้เปลี่ยน:** โค้ด production ทั้งหมด (`packages/*/src`, `workers/*/src`, `apps/web`), migration, workflow, environment variables, `model_configs`, pick, threshold, ranking, publishing และ settlement ไม่มีการเขียน DB

## Tests ที่รัน

- `npx vitest run scripts/research/sharpness.test.ts` — 15/15 ผ่าน: probability อยู่ใน [0, 1], สองฝั่งรวมกันเป็น 1 รวม quarter line, settlement quarter/push, โมเดลกับตลาดใช้เส้นเดียวกัน, ทุก config ทำนายแมตช์ชุดเดียวกัน, ไม่ใช้ผลหลัง kickoff − 3 วัน, holdout ไม่เข้า selection, รันซ้ำได้ผลเดิม, candidate ไม่แตะค่า M0/production, ตัวชี้วัด calibration ถูกต้องบนข้อมูลจำลอง
- `npx vitest run` — 496/496 ผ่าน (51 ไฟล์)
- `npm run typecheck` — ผ่าน
