# Daily Football Spotlight: owner's brief

The video brief the owner gave on 2026-11-03, plus the format change asked for the same day. The pipeline in this folder implements it; `.claude/skills/daily-spotlight-video/SKILL.md` is the runbook.

## Format (2026-11-03, second request: this is the current format)

> รวมทั้ง 3 คู่ เป็นคลิปเดียวกัน เปิดด้วย คู่น่าจับตาวันนี้ วันที่ 3 พฤศจิกายน UEFA Champions League Manchester United vs AS Roma / Championship Blackburn vs Stoke City QPR vs Burnley ฉากต่อไป เริ่ม บรรยาย คู่แรก คู่ที่สอง คู่ที่สาม และ ปิดด้วย เข็มทิศเกม อ่านเกมด้วยข้อมูลจริง video ยาวเกิน 60 วินาทีได้

So one film per football day: opening (title, date, every featured match grouped by league) → one segment per match (intro, analysis, pick) in the opening's order → one brand outro. Length is free (over 60 s is fine).

## Original brief (verbatim)

# Claude Motion — เข็มทิศเกม | Daily Football Spotlight

สร้างวิดีโอแนะนำคู่น่าจับตาฟุตบอลประจำวันนี้ โดยใช้ข้อมูลบทวิเคราะห์และ Pick จากระบบ Production ของเข็มทิศเกม

## VISUAL STYLE
- Isometric 3D Football Cinematic
- Futuristic Sports Broadcast + Motion Graphics
- Cinematic Lighting, Volumetric Light, 3D Depth
- สีหลัก: น้ำเงินเข้ม / ส้มทอง
- สนุก ตื่นเต้น เร้าใจ ดูทันสมัยและเป็นมืออาชีพ
- Vertical Video 9:16, 1080x1920, 30 FPS
- ความยาว 10–15 วินาทีต่อคู่

## SCENE 1 — MATCH INTRO (0–3s)
เปิดคลิปด้วยการแสดงโลโก้ของคู่น่าจับตาประจำวันนี้

- แสดง Official Logo ของสโมสรทั้งสองทีมพร้อมกัน
- แสดง Official Logo ของลีกที่ทั้งสองทีมกำลังแข่งขัน
- จัดองค์ประกอบแบบ Isometric 3D ลอยอยู่เหนือสนามฟุตบอล
- โลโก้ลีกอยู่ด้านบนหรือบริเวณกึ่งกลางส่วนบน
- โลโก้ทั้งสองสโมสรอยู่ซ้ายและขวาอย่างสมดุล
- แสดงชื่อทีม ชื่อลีก และชื่อรายการ "คู่น่าจับตาวันนี้"
- ใช้ Camera Zoom-in, 3D Rotation, Light Trails และ Cinematic Impact
- เปิดด้วยเสียงดนตรีเร้าใจและเสียงบรรยายที่ดึงดูดความสนใจทันที

สำคัญ: ใช้ไฟล์โลโก้จริงจากระบบ Input ห้ามสร้างโลโก้สโมสรหรือโลโก้ลีกขึ้นใหม่ด้วย AI

## SCENE 2 — MATCH ANALYSIS (3–8s)
- บรรยายบทวิเคราะห์ภาษาไทยอย่างกระชับ เข้าใจง่าย
- วิเคราะห์จุดเด่น ฟอร์มล่าสุด หรือความได้เปรียบของเกม
- ใช้ Isometric Tactical Football Pitch
- แสดง Tactical Arrows, Attack Movement, Defensive Lines หรือ Visual Statistics ตามเนื้อหาจริง
- ภาพเคลื่อนไหวต้องสอดคล้องกับสิ่งที่เสียงบรรยายกำลังพูด
- เน้นเฉพาะประเด็นสำคัญ ไม่ใส่ข้อมูลจนหน้าจอรก

## SCENE 3 — PICK REVEAL (8–12s)
สร้างช่วงเฉลย Pick ให้เป็นจุด Peak ของวิดีโอ

### กรณี Pick เป็นทีม
- โลโก้ทีมที่ระบบเลือกขยายขนาด 130–150%
- ใช้ Spotlight, Golden Glow, Cinematic Particle และ 3D Impact
- โลโก้ทีมตรงข้ามลดความสว่างและขนาดลง
- แสดง Pick และราคาตามข้อมูลจริงจากระบบ
- Camera Orbit หรือ Zoom เข้าหาทีมที่ได้รับเลือก

### กรณี Pick เป็น Over / Under
- แสดงตัวอักษร OVER หรือ UNDER แบบ 3D
- ใช้ Animation พุ่งเข้าสู่สนามพร้อม Impact Effect
- แสดงเส้นราคา เช่น O/U 2.5 ตามข้อมูลจริง
- ทำให้ Pick โดดเด่นและอ่านได้ทันที

## SCENE 4 — BRAND OUTRO (12–15s)
ปิดท้ายด้วย Branding "เข็มทิศเกม"

- แสดงโลโก้เข็มทิศเกมอย่างชัดเจนและครบถ้วน
- ใช้ Isometric Stadium เป็นฉากหลัง
- Animation โลโก้แบบ 3D Cinematic Reveal
- ใช้สีประจำแบรนด์ น้ำเงินเข้มและส้มทอง
- เสียงบรรยายจบอย่างกระชับ
- ปิดด้วย Signature Sound Effect ของช่อง
- ห้ามมีโลโก้หรือข้อความอื่นมาแข่งขันกับ Branding

## VOICEOVER — ELEVENLABS
- Provider: ElevenLabs
- Voice ID: KhBRXgEQjvfdIyXOu7G3
- Model: ElevenLabs v4
- Language: Thai
- Tone: สนุก มีพลัง ตื่นเต้น เป็นธรรมชาติ เหมือนนักวิเคราะห์ฟุตบอลกำลังเล่าให้ผู้ชมฟัง
- Speed: ปานกลางถึงเร็วเล็กน้อย แต่ต้องฟังชัด
- บทพูดรวมประมาณ 25–40 คำต่อคู่
- ห้ามอ่านเหมือน AI Robot หรือผู้ประกาศข่าวทางการเกินไป
- สร้างอารมณ์และเน้นน้ำหนักเสียงในช่วง Pick Reveal

## THAI SUBTITLE
- Subtitle ภาษาไทยต้องตรงกับเสียงบรรยาย 100%
- สร้างจากเสียงจริง พร้อม Timestamp ที่ถูกต้อง
- Font Bold อ่านง่าย เหมาะกับมือถือ
- Highlight คำสำคัญด้วยสีส้มทอง
- แสดงไม่เกิน 2 บรรทัด
- ใช้ Dynamic Word Highlight หรือ Phrase Reveal
- ห้าม Subtitle บังโลโก้สโมสร โลโก้ลีก หรือ Pick

## SOUND DESIGN
- Intro: Cinematic Riser + Sports Impact
- Analysis: Energetic Background Music + Subtle Stadium Atmosphere
- Pick Reveal: Whoosh + Bass Impact + Crowd Excitement
- Brand Outro: Signature Audio Logo ของเข็มทิศเกม

## CONTENT ACCURACY
- ใช้ข้อมูลการแข่งขัน บทวิเคราะห์ และ Pick จากระบบ Production เท่านั้น
- ห้ามแต่งสถิติ ข่าว อาการบาดเจ็บ หรือข้อมูลนักเตะขึ้นเอง
- ห้ามเปลี่ยน Pick ที่ระบบเลือก
- ห้ามสร้างหรือดัดแปลงโลโก้สโมสรและโลโก้ลีก
- ชื่อทีม ชื่อลีก ตลาด และราคาต้องตรงกับ Input
- ห้ามกล่าวอ้างว่าผลการแข่งขันแน่นอน

## FINAL CREATIVE GOAL
วิดีโอต้องมีเอกลักษณ์ที่ผู้ชมจดจำได้ทันทีตั้งแต่โลโก้สโมสรและโลโก้ลีกเปิดตัว ไปจนถึงช่วง Pick Reveal และ Branding เข็มทิศเกมในตอนจบ

ทุกคู่ต้องดูสนุก ตื่นเต้น กระชับ เข้าใจง่าย และมีคุณภาพเหมือนรายการฟุตบอล 3D Motion Graphics ระดับมืออาชีพ
