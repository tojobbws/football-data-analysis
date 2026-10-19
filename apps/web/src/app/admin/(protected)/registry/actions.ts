'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authClient, requireAdmin } from '@/lib/auth';

type Sb = Awaited<ReturnType<typeof authClient>>;

/** Back to the page with a message. redirect() throws, so call it last. */
function back(kind: 'ok' | 'error', text: string): never {
  revalidatePath('/admin/registry');
  revalidatePath('/today');
  revalidatePath('/');
  redirect(`/admin/registry?${kind}=${encodeURIComponent(text)}`);
}

const int = (v: FormDataEntryValue | null, fallback: number) => {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) ? n : fallback;
};
const text = (v: FormDataEntryValue | null) => String(v ?? '').trim();

/** A team given as its API-Football id or a name; a name must lead to exactly one team. */
async function resolveTeam(sb: Sb, input: string): Promise<{ id: number; name: string } | string> {
  if (!input) return 'ใส่ชื่อทีมหรือ ID';
  if (/^\d+$/.test(input)) {
    const { data } = await sb.from('teams').select('id, name').eq('id', Number(input)).maybeSingle();
    return data ? { id: Number(data.id), name: String(data.name) } : `ไม่พบทีม ID ${input}`;
  }
  const { data } = await sb.from('teams').select('id, name, country').ilike('name', `%${input}%`).limit(20);
  const rows = data ?? [];
  const exact = rows.filter((r) => String(r.name).toLowerCase() === input.toLowerCase());
  const hit = exact.length === 1 ? exact : rows;
  if (hit.length === 1) return { id: Number(hit[0]!.id), name: String(hit[0]!.name) };
  if (!hit.length) return `ไม่พบทีมชื่อ "${input}"`;
  return `"${input}" ตรงกับหลายทีม ใส่ ID แทน: ${hit.slice(0, 6).map((r) => `${r.id} ${r.name}${r.country ? ` (${r.country})` : ''}`).join(', ')}`;
}

async function resolveLeague(sb: Sb, input: string): Promise<{ id: number; name: string } | string> {
  if (!input) return 'ใส่ชื่อลีกหรือ ID';
  if (/^\d+$/.test(input)) {
    const { data } = await sb.from('leagues').select('id, name').eq('id', Number(input)).maybeSingle();
    return data ? { id: Number(data.id), name: String(data.name) } : `ไม่พบลีก ID ${input}`;
  }
  const { data } = await sb.from('leagues').select('id, name, country').ilike('name', `%${input}%`).limit(20);
  const rows = data ?? [];
  if (rows.length === 1) return { id: Number(rows[0]!.id), name: String(rows[0]!.name) };
  if (!rows.length) return `ไม่พบลีกชื่อ "${input}"`;
  return `"${input}" ตรงกับหลายลีก ใส่ ID แทน: ${rows.slice(0, 6).map((r) => `${r.id} ${r.name} (${r.country})`).join(', ')}`;
}

/** RLS (fp_is_admin) is the real guard; requireAdmin only gives a clean redirect. */
export async function saveTeam(form: FormData) {
  await requireAdmin();
  const sb = await authClient();
  const popularity = int(form.get('popularity'), -1);
  if (popularity < 0 || popularity > 100) back('error', 'ความนิยมต้องเป็นเลข 0–100');
  const team = await resolveTeam(sb, text(form.get('team')));
  if (typeof team === 'string') back('error', team);
  const { error } = await sb
    .from('team_popularity')
    .upsert({ team_id: team.id, season: int(form.get('season'), 0), popularity, note: text(form.get('note')) || null }, { onConflict: 'team_id,season' });
  if (error) back('error', error.message);
  back('ok', `บันทึก ${team.name} = ${popularity}`);
}

export async function removeTeam(form: FormData) {
  await requireAdmin();
  const sb = await authClient();
  const { error } = await sb.from('team_popularity').delete().eq('team_id', int(form.get('team_id'), 0)).eq('season', int(form.get('season'), 0));
  if (error) back('error', error.message);
  back('ok', 'ลบแล้ว');
}

export async function saveLeague(form: FormData) {
  await requireAdmin();
  const sb = await authClient();
  const importance = int(form.get('importance'), -1);
  if (importance < 0 || importance > 100) back('error', 'ความสำคัญต้องเป็นเลข 0–100');
  const league = await resolveLeague(sb, text(form.get('league')));
  if (typeof league === 'string') back('error', league);
  const { error } = await sb.from('league_importance').upsert(
    { league_id: league.id, season: int(form.get('season'), 0), importance, is_thai: form.get('is_thai') === 'on', note: text(form.get('note')) || null },
    { onConflict: 'league_id,season' },
  );
  if (error) back('error', error.message);
  back('ok', `บันทึก ${league.name} = ${importance}`);
}

export async function removeLeague(form: FormData) {
  await requireAdmin();
  const sb = await authClient();
  const { error } = await sb.from('league_importance').delete().eq('league_id', int(form.get('league_id'), 0)).eq('season', int(form.get('season'), 0));
  if (error) back('error', error.message);
  back('ok', 'ลบแล้ว');
}

export async function saveRivalry(form: FormData) {
  await requireAdmin();
  const sb = await authClient();
  const weight = int(form.get('weight'), -1);
  const name = text(form.get('name'));
  if (weight < 0 || weight > 15) back('error', 'น้ำหนักต้องเป็นเลข 0–15');
  if (!name) back('error', 'ใส่ชื่อคู่ปรับ');
  const [a, b] = await Promise.all([resolveTeam(sb, text(form.get('team_a'))), resolveTeam(sb, text(form.get('team_b')))]);
  if (typeof a === 'string') back('error', a);
  if (typeof b === 'string') back('error', b);
  if (a.id === b.id) back('error', 'เลือกสองทีมที่ต่างกัน');
  const { error } = await sb
    .from('rivalries')
    .upsert({ team_a_id: Math.min(a.id, b.id), team_b_id: Math.max(a.id, b.id), name, weight }, { onConflict: 'team_a_id,team_b_id' });
  if (error) back('error', error.message);
  back('ok', `บันทึกคู่ปรับ ${a.name} – ${b.name}`);
}

export async function removeRivalry(form: FormData) {
  await requireAdmin();
  const sb = await authClient();
  const { error } = await sb.from('rivalries').delete().eq('team_a_id', int(form.get('team_a_id'), 0)).eq('team_b_id', int(form.get('team_b_id'), 0));
  if (error) back('error', error.message);
  back('ok', 'ลบแล้ว');
}
