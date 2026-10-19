import { Empty, Section } from '@/components/ui';
import { authClient } from '@/lib/auth';
import { removeLeague, removeRivalry, removeTeam, saveLeague, saveRivalry, saveTeam } from './actions';

export const dynamic = 'force-dynamic';

const input = 'w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm';
const btn = 'rounded-full bg-[var(--color-ink)] px-3 py-1.5 text-xs text-white';
const del = 'rounded-full px-2 py-1 text-xs text-rose-700 hover:bg-rose-50';

interface TeamRow { team_id: number; season: number; popularity: number; note: string | null; team: { name: string; country: string | null } | null }
interface LeagueRow { league_id: number; season: number; importance: number; is_thai: boolean; note: string | null; league: { name: string; country: string | null } | null }
interface RivalryRow { team_a_id: number; team_b_id: number; name: string; weight: number; a: { name: string } | null; b: { name: string } | null }

const seasonLabel = (s: number) => (s === 0 ? 'ทุกฤดูกาล' : String(s));

/**
 * Registry that orders the site's big matches and marks the Thai leagues (slice 03).
 * Display order only: nothing here touches a probability, an edge, a pick or the featured list.
 */
export default async function AdminRegistry({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const q = await searchParams;
  const sb = await authClient();
  const [teams, leagues, rivalries] = await Promise.all([
    sb.from('team_popularity').select('team_id, season, popularity, note, team:teams(name, country)').order('popularity', { ascending: false }).limit(500),
    sb.from('league_importance').select('league_id, season, importance, is_thai, note, league:leagues(name, country)').order('importance', { ascending: false }).limit(200),
    sb
      .from('rivalries')
      .select('team_a_id, team_b_id, name, weight, a:teams!rivalries_team_a_id_fkey(name), b:teams!rivalries_team_b_id_fkey(name)')
      .order('weight', { ascending: false })
      .limit(200),
  ]);
  const err = teams.error ?? leagues.error ?? rivalries.error;
  const teamRows = (teams.data ?? []) as unknown as TeamRow[];
  const leagueRows = (leagues.data ?? []) as unknown as LeagueRow[];
  const rivalryRows = (rivalries.data ?? []) as unknown as RivalryRow[];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold">ทะเบียนความนิยม (คู่ใหญ่ · ฟุตบอลไทย)</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
          ค่า 0–100 ใช้<b>จัดลำดับ</b>คู่ใหญ่บนหน้าแรกและ /today กับระบุลีกที่เป็นฟุตบอลไทยเท่านั้น ไม่มีผลกับโอกาส ส่วนต่าง เข็มทิศเกม หรือเข็มทิศเกมประจำวัน
          ใส่ทีม/ลีกด้วย ID ของ API-Football (หรือชื่อที่ตรงกับทีมเดียว) ฤดูกาล 0 = ทุกฤดูกาล
        </p>
      </header>
      {q.ok ? <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{q.ok}</p> : null}
      {q.error ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{q.error}</p> : null}
      {err ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{err.message}</p> : null}

      <Section title="ทีม" aside={`${teamRows.length} ทีม`}>
        <form action={saveTeam} className="mb-3 grid gap-2 sm:grid-cols-[2fr_1fr_1fr_2fr_auto] sm:items-end">
          <label className="text-xs">ทีม (ID หรือชื่อ)<input name="team" required className={input} placeholder="541 หรือ Real Madrid" /></label>
          <label className="text-xs">ฤดูกาล<input name="season" defaultValue="0" inputMode="numeric" className={input} /></label>
          <label className="text-xs">ความนิยม 0–100<input name="popularity" required inputMode="numeric" className={input} /></label>
          <label className="text-xs">หมายเหตุ<input name="note" className={input} /></label>
          <button className={btn}>บันทึก</button>
        </form>
        {teamRows.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {teamRows.map((t) => (
              <li key={`${t.team_id}:${t.season}`} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  <b className="tabular-nums">{t.popularity}</b> · {t.team?.name ?? t.team_id} <span className="text-xs text-slate-500">#{t.team_id} · {seasonLabel(t.season)}{t.note ? ` · ${t.note}` : ''}</span>
                </span>
                <form action={removeTeam}>
                  <input type="hidden" name="team_id" value={t.team_id} />
                  <input type="hidden" name="season" value={t.season} />
                  <button className={del}>ลบ</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีทีมในทะเบียน</Empty>
        )}
      </Section>

      <Section title="ลีกและรายการ" aside={`${leagueRows.length} รายการ`}>
        <form action={saveLeague} className="mb-3 grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto_2fr_auto] sm:items-end">
          <label className="text-xs">ลีก (ID หรือชื่อ)<input name="league" required className={input} placeholder="296 หรือ Thai League 1" /></label>
          <label className="text-xs">ฤดูกาล<input name="season" defaultValue="0" inputMode="numeric" className={input} /></label>
          <label className="text-xs">ความสำคัญ 0–100<input name="importance" required inputMode="numeric" className={input} /></label>
          <label className="flex items-center gap-1.5 pb-2 text-xs"><input type="checkbox" name="is_thai" />ฟุตบอลไทย</label>
          <label className="text-xs">หมายเหตุ<input name="note" className={input} /></label>
          <button className={btn}>บันทึก</button>
        </form>
        {leagueRows.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {leagueRows.map((l) => (
              <li key={`${l.league_id}:${l.season}`} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  <b className="tabular-nums">{l.importance}</b> · {l.league?.name ?? l.league_id}{l.league?.country ? ` (${l.league.country})` : ''}{' '}
                  {l.is_thai ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">ไทย</span> : null}{' '}
                  <span className="text-xs text-slate-500">#{l.league_id} · {seasonLabel(l.season)}{l.note ? ` · ${l.note}` : ''}</span>
                </span>
                <form action={removeLeague}>
                  <input type="hidden" name="league_id" value={l.league_id} />
                  <input type="hidden" name="season" value={l.season} />
                  <button className={del}>ลบ</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีลีกในทะเบียน (ลีกที่ไม่อยู่ในทะเบียนใช้ค่ามาตรฐาน 30)</Empty>
        )}
      </Section>

      <Section title="คู่ปรับ / ดาร์บี้" aside={`${rivalryRows.length} คู่`}>
        <form action={saveRivalry} className="mb-3 grid gap-2 sm:grid-cols-[2fr_2fr_2fr_1fr_auto] sm:items-end">
          <label className="text-xs">ทีม A<input name="team_a" required className={input} /></label>
          <label className="text-xs">ทีม B<input name="team_b" required className={input} /></label>
          <label className="text-xs">ชื่อคู่<input name="name" required className={input} placeholder="El Clásico" /></label>
          <label className="text-xs">น้ำหนัก 0–15<input name="weight" defaultValue="10" inputMode="numeric" className={input} /></label>
          <button className={btn}>บันทึก</button>
        </form>
        {rivalryRows.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {rivalryRows.map((r) => (
              <li key={`${r.team_a_id}-${r.team_b_id}`} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  <b className="tabular-nums">{r.weight}</b> · {r.name} <span className="text-xs text-slate-500">{r.a?.name ?? r.team_a_id} – {r.b?.name ?? r.team_b_id}</span>
                </span>
                <form action={removeRivalry}>
                  <input type="hidden" name="team_a_id" value={r.team_a_id} />
                  <input type="hidden" name="team_b_id" value={r.team_b_id} />
                  <button className={del}>ลบ</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีคู่ปรับ</Empty>
        )}
      </Section>
    </div>
  );
}
