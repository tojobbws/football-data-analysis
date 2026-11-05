# Yesterday Prediction Recap: owner's brief

The owner gave this brief on 2026-11-04 (the recap of 3 November). `recap-fetch.cjs`, `recap.cjs` and `recap.html` implement it; `.claude/skills/daily-recap-video/SKILL.md` is the runbook.

How the build follows the brief:
- The film shows the day's คู่น่าจับตา, every pick right or wrong, in the opening order of the spotlight film.
- Result wording follows the site's result badges: ทายถูก / ทายผิด / ทายถูกครึ่ง / ทายผิดครึ่ง / เสมอตัว. The brief's "ได้ครึ่ง / เสียครึ่ง" is bookmaker wording, so the badges' words are used instead.
- The win rate uses the same counting as /performance (`daySummary`): ถูก ÷ (ถูก + ผิด), a half result counts as half, and เสมอตัว / โมฆะ are left out.
- No odds appear on the recap.

## Brief (verbatim)

สร้างวิดีโอ Motion Graphic สำหรับเพจฟุตบอล **"เข็มทิศเกม"** ในรูปแบบรายการสรุปผลการทำนายฟุตบอลประจำวัน (Yesterday Prediction Recap)

### Concept
"เมื่อเสียงนกหวีดสุดท้ายดังขึ้น มาดูกันว่าเข็มทิศเกมนำทางเราได้แม่นยำแค่ไหน"

### Video Specifications
- อัตราส่วน 9:16 แนวตั้ง สำหรับ Facebook Reels, TikTok และ YouTube Shorts
- ความยาว 30–45 วินาที
- สไตล์ Sports Broadcast / Premium Football Motion Graphic
- ใช้สีประจำแบรนด์ ดำ น้ำเงินเข้ม และสีทอง
- Motion ลื่นไหล รวดเร็ว ทันสมัย มีพลัง
- ใช้เสียงพากย์ภาษาไทย น้ำเสียงผู้ประกาศข่าวกีฬามืออาชีพ
- ใช้เสียง ElevenLabs Voice ID: KhBRXgEQjvfdIyXOu7G3

### Scene 1 — Opening (0–4 วินาที)
เปิดด้วยสนามฟุตบอลกลางคืน บรรยากาศ Stadium Lights
โลโก้ "เข็มทิศเกม" ปรากฏขึ้นพร้อมเอฟเฟกต์แสงและเสียง Impact
ข้อความ:
"สรุปผลงานการทำนาย ประจำวันที่ [วันที่เมื่อวาน]"

### Scene 2 — Match Recap (4–20 วินาที)
แสดงผลการแข่งขันฟุตบอลทีละคู่ในรูปแบบ Broadcast Graphic

แต่ละคู่ประกอบด้วย:
- โลโก้สโมสรทั้งสองทีม
- ชื่อทีมและสกอร์จริง
- Prediction ของเข็มทิศเกม
- ผลลัพธ์ด้วย Motion Animation

หากทายถูก:
แสดงเครื่องหมาย ✓ สีเขียว พร้อมข้อความ "ทายถูก"

หากทายผิด:
แสดงเครื่องหมาย ✕ สีแดง พร้อมข้อความ "ทายผิด"

หากเป็นผลเสมอหรือได้ครึ่ง:
แสดงเครื่องหมายและข้อความ "ได้ครึ่ง" หรือ "เสียครึ่ง" ตามผลจริง

ใช้ Transition แบบ Scoreboard Flip, Light Sweep และ Dynamic Zoom

### Scene 3 — Performance Summary (20–35 วินาที)
เข้าสู่หน้า Dashboard สรุปผลงานประจำวัน

แสดงข้อมูล:
- จำนวนคู่ที่วิเคราะห์ทั้งหมด
- จำนวนคู่ทายถูก
- จำนวนคู่ทายผิด
- จำนวนคู่ได้ครึ่ง / เสียครึ่ง
- Win Rate (%) โดยคำนวณจากข้อมูลจริง

ตัวเลขต้องปรากฏด้วย Count-up Animation อย่างโดดเด่นและอ่านง่าย

### Scene 4 — Closing Branding (35–45 วินาที)
สนามฟุตบอลมืดลง เหลือแสง Spotlight ส่องไปที่โลโก้แบรนด์

ข้อความ:
"วิเคราะห์ทุกเกม เรียนรู้ทุกผลลัพธ์"
"เข็มทิศเกม — เพราะฟุตบอลมีมากกว่าที่เห็น"

ปิดท้ายด้วย Logo Reveal และเสียง Signature Sound

### Important Rules
- ใช้ข้อมูลการแข่งขันและผลทำนายจริงเท่านั้น ห้ามสร้างข้อมูลหรือสกอร์ขึ้นมาเอง
- ต้องแสดงทั้งผลถูกและผิดอย่างโปร่งใส
- ห้ามใช้ข้อความเชิญชวนให้เล่นการพนัน
- ภาษาไทยต้องถูกต้อง อ่านง่าย ไม่มีข้อความผิดเพี้ยน
- รักษา Brand Identity ของเข็มทิศเกมให้สม่ำเสมอทุก Scene
- เน้นความเป็น Football Analytics & Sports Media ไม่ใช่ Betting Advertisement
