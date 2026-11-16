# ข้อมูลที่ส่งให้ AI เลือก pick (Hybrid AI input v2.0)

อัปเดต 2026-11-16 · prompt `hybrid-ai-v2.0` (ADR 0020) · ตัวอย่างจากคู่ Germany vs Netherlands, UEFA Nations League, รอบ DAILY 16 พ.ย. 14:11 น.

## ภาพรวม

- ทุกคู่ในรอบเลือก pick ประจำวัน (14:00 น.) จะถูกรวมข้อมูลเป็น JSON ก้อนเดียว แล้วส่งให้ `gpt-6-luna` พร้อม system prompt
- **ตัวเลขทุกตัวมาจากฐานข้อมูลของเราหรือจาก API-Football** บางตัวเราคำนวณเอง ส่วน AI ทำได้แค่เลือกฝั่งกับเขียนคำอธิบาย ห้ามสร้างตัวเลขใหม่ ถ้าในข้อความมีตัวเลขที่ไม่อยู่ใน input จะถูก number guard ตีตก
- ข้อมูลทั้งหมดเป็น **ข้อมูล ณ เวลาที่ตัดสิน** (`prediction_timestamp_utc`) ไม่มีอะไรจากหลังเวลานั้น
- input ทุกก้อนเก็บไว้ครบใน `hybrid_decisions.input` พร้อม `input_hash` จึงย้อนดูได้ทุกเมื่อว่า AI เห็นอะไรบ้าง
- ขนาดราว 25–45 KB ต่อคู่ (input รุ่นก่อน v2.0 ราว 14 KB)

โค้ดที่เกี่ยวข้อง

- `workers/analysis/src/hybrid-job.ts`: `collectHybridInput()` ดึงข้อมูลจากฐานข้อมูล
- `workers/analysis/src/hybrid-input-v20.ts`: `collectV20()` ส่วนที่เพิ่มใน v2.0
- `packages/ai/src/hybrid.ts`: `buildHybridInput()` จัดรูป JSON และ `HYBRID_SYSTEM_PROMPT`
- `packages/analysis/src/hybrid-market.ts`: เลือกเส้นหลักของตลาด

## โครงสร้าง input

| ส่วน | มีอะไร | ที่มา |
|---|---|---|
| `match` | ทีมเหย้า ทีมเยือน รายการแข่ง เวลาเตะ (UTC) รอบที่ตัดสิน (`DAILY`) | ตาราง fixtures |
| `prediction_timestamp_utc` | เวลาที่รวบรวมข้อมูลและตัดสิน | ระบบ |
| `match_context` (v2.0) | นัดที่/รอบ, stage, สนามกลางหรือไม่, ดาร์บี้, เกมสองนัด (ผลนัดแรก, สกอร์รวม, ต้องชนะกี่ลูกถึงเสมอสกอร์รวม), สถิติพบกัน 5 นัดล่าสุด | fixtures, competition_rules, rivalries |
| `elo_ratings` (v2.0) | Elo ทั้งสองทีม ส่วนต่าง ค่าความได้เปรียบเจ้าบ้าน โอกาสคาดหวังของเจ้าบ้าน จำนวนนัดที่ใช้คำนวณ | เราคำนวณจากผลบอลทุกนัดที่เก็บไว้ |
| `home_team` / `away_team` | ดูตารางถัดไป | หลายแหล่ง |
| `injuries` | ผู้เล่นเจ็บหรือติดโทษ: ทีม ชื่อ ประเภท สาเหตุ จำนวนนัดที่ได้ตัวจริงล่าสุด และสถิติทั้งฤดูกาล (v2.0) | API-Football injuries, lineups, player stats |
| `confirmed_lineup` | 11 ตัวจริงของทั้งสองทีม ถ้าประกาศแล้ว (ตอน 14:00 ส่วนใหญ่ยังไม่ประกาศ ค่าจึงเป็น `null`) | API-Football lineups |
| `recent_starters` | แต่ละทีมใน 5 lineup ล่าสุด ใครได้ตัวจริงกี่นัด ถ้าเป็นบอลถ้วยในประเทศ จะบอกด้วยว่าใครเป็นตัวจริงในรอบก่อน (ADR 0016) | lineups ที่เก็บไว้ |
| `market` | เส้นหลักแฮนดิแคป, เส้นหลักสูง/ต่ำ, ราคา 1X2 แบบตัดค่าน้ำ, การขยับของตลาด (v2.0) | ราคาจากเจ้ามือ (odds_quotes) |
| `api_football_prediction` (v2.0) | ทำนายของ API-Football เอง: % ชนะ/เสมอ/แพ้, คำแนะนำ, แนวโน้มประตู | API-Football predictions |
| `data_quality` | จำนวนนัดย้อนหลังที่มีจริง, lineup ประกาศแล้วหรือยัง, ลีกนี้มีข้อมูลคนเจ็บหรือไม่, ขอบเขตข้อมูล, นิยามตัวชี้วัด xG, รายการ **ข้อมูลที่ขาด** (`missing`) | ระบบ |

### ข้อมูลรายทีม (`home_team`, `away_team`)

| ฟิลด์ | มีอะไร |
|---|---|
| `recent_matches` | 10 นัดล่าสุด (ใหม่สุดก่อน) แต่ละนัดมี: วันที่, รายการ, เหย้า/เยือน, คู่แข่ง, อันดับของคู่แข่ง ณ วันแข่ง, สกอร์, xG ได้/เสีย, ยิงตรงกรอบได้/เสีย, xG ส่วนต่าง, npxG (xG ไม่รวมจุดโทษ), shooting performance (ประตูลบ xG), xPTS, goals prevented ของผู้รักษาประตู · v2.0 เพิ่ม: % ครองบอล, เตะมุม, ใบเหลือง, นาทีที่โดนใบแดง, Elo ทั้งสองฝั่งก่อนเกม, เส้นแฮนดิแคปและเส้นสูง/ต่ำตอนปิดราคา, ผลจริงเทียบกับเส้นปิดราคา (ทั้งประตูและ xG) |
| `last_10`, `last_5` | สรุปช่วงนั้น: ชนะ/เสมอ/แพ้, ค่าเฉลี่ยประตูได้/เสีย, จำนวนนัดที่ประตูรวมสูงกว่า/เท่ากับ/ต่ำกว่าเส้นสูง/ต่ำหลักของคู่นี้, ค่าเฉลี่ย xG, npxG, ยิงตรงกรอบ, xPTS เทียบกับแต้มจริง · v2.0 เพิ่ม: ครองบอล, เตะมุม, ใบเหลือง, จำนวนนัดที่มีใบแดง, Elo เฉลี่ยของคู่แข่ง, ผลเฉลี่ยเทียบกับเส้นปิดราคา · ทุกตัวบอกว่าคำนวณจากกี่นัด |
| `home_matches_in_last_10` / `away_matches_in_last_10` | สรุปเหมือนกัน เฉพาะนัดเหย้า (ทีมเจ้าบ้าน) หรือเฉพาะนัดเยือน (ทีมเยือน) |
| `rest_days_before_this_match` | จำนวนวันพักนับถึงเวลาเตะ |
| `recent_congestion` | จำนวนนัดใน 14 วันก่อนเตะ |
| `league_table` | อันดับ, จำนวนทีมในตาราง, จำนวนนัดที่แข่ง, แต้ม, ประตูได้เสีย |
| `next_match` | นัดถัดไปหลังเกมนี้: อีกกี่วัน, รายการ, เหย้า/เยือน (เฉพาะรายการที่เราติดตาม) |
| `table_context` (v2.0) | โซนในตาราง (ลุ้นแชมป์, ยุโรป, หนีตก ฯลฯ), ห่างโซนบนและโซนล่างกี่แต้ม, ห่างจ่าฝูงกี่แต้ม, เหลือกี่นัด, สถิติเหย้าและเยือนทั้งฤดูกาล |
| `absences` (v2.0) | ผู้เล่นที่เจ็บรวมกันมีส่วนในประตู แอสซิสต์ และนาทีลงเล่นของทีมกี่ % |
| `starters_workload` (v2.0) | นาทีลงเล่นเฉลี่ยของตัวจริงประจำใน 7 และ 14 วันก่อนเตะ และ 3 คนที่เล่นหนักที่สุด |

### ข้อมูลตลาด (`market`)

| ฟิลด์ | มีอะไร |
|---|---|
| `asian_handicap` | เส้นหลักแฮนดิแคป (เฉพาะเส้นที่มีเจ้ามือราคาสดอย่างน้อย 3 ราย และราคาใกล้ 50/50 ที่สุด), ทีมต่อ, จำนวนเจ้ามือ, อายุราคาเป็นชั่วโมง และตัวเลือก 2 ฝั่ง (FAVORITE / UNDERDOG) แต่ละฝั่งมีราคากลาง (median) กับความน่าจะเป็นแบบตัดค่าน้ำ |
| `over_under` | เส้นหลักสูง/ต่ำ ใช้กติกาเดียวกัน ตัวเลือก OVER / UNDER |
| `match_odds_1x2_no_vig` | โอกาสเหย้าชนะ เสมอ เยือนชนะ แบบตัดค่าน้ำ และจำนวนเจ้ามือ |
| `movement` (v2.0) | เส้นหลักและโอกาส 1X2 ในสามช่วง: ตอนเปิดราคา (ราคาแรกที่เราเก็บได้), 24 ชั่วโมงก่อน และตอนนี้ พร้อมค่าที่เปลี่ยนไป |

AI เลือกได้ **เฉพาะตัวเลือกที่อยู่ใน `options`** เท่านั้น ถ้าตลาดไหนไม่มีเส้นหลักที่ใช้ได้ (`status` ไม่ใช่ `OK`) ตลาดนั้นจะไม่มีตัวเลือกให้เลือก ถ้าไม่มีทั้งสองตลาด ระบบจะไม่เรียก AI เลยและบันทึกเป็น NO_PICK

## สิ่งที่ไม่ได้ส่งให้ AI

- **โมเดล Dixon-Coles ของเรา:** ถอดออกตั้งแต่ v1.6 เพราะเอียงไปทางทีมรองและต่ำราว 5 จุด และเมื่อมีราคาตลาดอยู่แล้วก็ไม่ได้เพิ่มข้อมูลอะไร (ADR 0013)
- **เส้นรอง:** ส่งเฉพาะเส้นหลักของแต่ละตลาด (ADR 0008)
- **ข่าว บทสัมภาษณ์ สภาพอากาศ ผู้ตัดสิน การซื้อขายนักเตะ:** ไม่มีในฐานข้อมูล
- **ตัวจริงที่คาดการณ์:** ส่งเฉพาะสถิติการเป็นตัวจริงที่ผ่านมา และ prompt ห้ามเดาตัวจริง
- **ความรู้นอก input:** prompt สั่งห้ามใช้ความรู้ภายนอกเกี่ยวกับทีมหรือนักเตะ

## ข้อมูลที่มักขาด (AI ได้รับแจ้งใน `data_quality.missing`)

ตัวอย่างจากคู่ Germany vs Netherlands:

- ไม่มี xG ใน 10 นัดล่าสุด (ทีมชาติมักไม่มี xG)
- ไม่มีอันดับคู่แข่งใน 20 นัด (บอลถ้วย, ลีกที่แบ่งสาย หรือคู่แข่งยังไม่ได้ลงแข่ง)
- ไม่มีนัดถัดไปในรายการที่เราติดตาม
- lineup ยังไม่ประกาศ
- **ลีกนี้ไม่มีข้อมูลคนเจ็บ** รายการคนเจ็บที่ว่างจึงไม่ได้แปลว่าไม่มีใครเจ็บ
- ไม่มีเส้นปิดราคาใน 16 นัด (เราเริ่มเก็บตั้งแต่ 2026-10-04 และเก็บเฉพาะลีกที่ติดตาม)

ช่องโหว่ที่เป็นโครงสร้างอยู่แล้ว:

- **บอลถ้วยในประเทศส่วนใหญ่ไม่อยู่ในฐานข้อมูล** (FA Cup, DFB-Pokal, Coppa Italia, Coupe de France ฯลฯ) วันพักและจำนวนนัดจึงอาจดูน้อยกว่าความจริง
- ตอน 14:00 ส่วนใหญ่ lineup ยังไม่ประกาศ และหลังจากนั้นไม่มีรอบแก้ pick แล้ว (ADR 0014)

## ตัวอย่าง (ย่อ)

```json
{
  "match": { "home": "Germany", "away": "Netherlands", "competition": "UEFA Nations League", "kickoff_utc": "2026-11-16T19:45:00.000Z", "publish_round": "DAILY" },
  "prediction_timestamp_utc": "2026-11-16T07:11:05.758Z",
  "match_context": {
    "round": "League A - 6", "stage": "LEAGUE_PHASE", "neutral_venue": null, "derby": null, "two_legged_tie": null,
    "head_to_head": { "matches": 3, "home_team_wins": 1, "draws": 2, "home_team_losses": 0, "meetings": ["…"] }
  },
  "elo_ratings": { "home_rating": 1544, "away_rating": 1572, "home_minus_away": -28, "home_advantage_points": 60, "home_expected_score": 0.546 },
  "home_team": { "name": "Germany", "recent_matches": ["… 10 นัด …"], "last_10": {"…": "…"}, "last_5": {"…": "…"}, "table_context": {"…": "…"}, "starters_workload": {"…": "…"} },
  "away_team": {
    "name": "Netherlands",
    "last_5": { "wins": 3, "draws": 2, "losses": 0, "goals_for_avg": 2.8, "xg_for_avg": 2.88, "xg_against_avg": 1.19, "total_goals_vs_line": { "line": 3.5, "over": 2, "under": 3 } },
    "league_table": { "rank": 1, "tableSize": 4, "played": 5, "points": 11, "goalDiff": 9 },
    "table_context": { "zone": "Play Offs: Quarter-finals", "stakes": { "points_ahead_of_second": 3, "league_matches_left_including_this": 1 } }
  },
  "injuries": [],
  "confirmed_lineup": null,
  "market": {
    "asian_handicap": { "status": "OK", "home_line": -0.5, "favourite": "Germany", "bookmakers": 5,
      "options": [ { "option": "FAVORITE", "team_or_total": "Germany", "line": -0.5, "odds_median": 1.88, "market_probability_no_vig": 0.51295 }, "… UNDERDOG …" ] },
    "over_under": { "status": "OK", "line": 3.5, "bookmakers": 8,
      "options": [ { "option": "OVER", "line": 3.5, "odds_median": 1.965, "market_probability_no_vig": 0.48423 }, "… UNDER …" ] },
    "match_odds_1x2_no_vig": { "home": 0.50601, "draw": 0.22719, "away": 0.2668 },
    "movement": { "opening": {"…": "…"}, "day_ago": { "total_line": 3.25 }, "now": { "total_line": 3.5 }, "since_day_ago": { "total_line_change": 0.25 } }
  },
  "api_football_prediction": { "percent_home": 45, "percent_draw": 45, "percent_away": 10, "advice": "Double chance : Germany or draw" },
  "data_quality": { "lineups_confirmed": false, "injuries_coverage": "unavailable_for_league", "missing": ["no xG for 10 recent matches", "…"] }
}
```

## คำตอบที่ AI ต้องส่งกลับ (วิธีปัจจุบัน: ถาม 3 ครั้งแล้วโหวต)

ทุกครั้งที่ถาม AI ต้องตอบเป็น JSON ตาม `HYBRID_OUTPUT_SCHEMA`

- **ตัดสิน:** `market` (AH / OU / NONE), `side` (FAVORITE / UNDERDOG / OVER / UNDER / NO_PICK), `main_line`, `confidence` (HIGH / MEDIUM / LOW / NONE)
- **เหตุผลภาษาไทย:** ประเมินทีม, ภาพรวมเกม, เทียบกับตลาด, ประเมินทีละตัวเลือก, หลักฐานสนับสนุน, หลักฐานแย้ง, ความเสี่ยง, ข้อมูลที่ขาด, `summary_th`

ระบบถาม 3 ครั้ง ถ้าอย่างน้อย 2 ครั้งเลือกเหมือนกันก็ใช้ข้อนั้น (ADR 0013) คำตอบที่ฝั่งหรือเส้นไม่ตรงกับตัวเลือก มีคำต้องห้าม หรือมีตัวเลขที่ไม่อยู่ใน input จะถูกนับเป็น INVALID
