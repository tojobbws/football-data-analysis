import { currentAdmin } from '@/lib/auth';
import { bannerKey, checkImageFile, checkImageSize, type BannerImageKind } from '@/lib/banners';
import { bannersEnv } from '@/lib/banners-server';
import { presign } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * POST /api/admin/banners/upload {kind, type, bytes, width, height}: checks the picture and hands back a short-lived
 * link to PUT it straight into the public banner bucket, plus the address it will be served at. ADMIN only.
 */
export async function POST(req: Request) {
  const admin = await currentAdmin();
  if (!admin) return json({ error: 'ต้องเข้าสู่ระบบหลังบ้าน' }, 401);
  if (admin.role !== 'ADMIN') return json({ error: 'เฉพาะ ADMIN จัดการป้ายได้' }, 403);
  const { r2, publicUrl, missing } = bannersEnv();
  if (!r2) return json({ error: `ยังไม่ได้ตั้งค่า ${missing.join(', ')}` }, 503);
  const b = (await req.json().catch(() => null)) as { kind?: string; type?: string; bytes?: number; width?: number; height?: number } | null;
  if (!b || (b.kind !== 'wide' && b.kind !== 'phone')) return json({ error: 'ข้อมูลไม่ครบ' }, 400);
  const kind: BannerImageKind = b.kind;
  const type = String(b.type ?? '');
  const error = checkImageFile(kind, type, Number(b.bytes)) ?? checkImageSize(kind, Number(b.width), Number(b.height));
  if (error) return json({ error }, 400);
  const key = bannerKey(kind, type);
  return json({ putUrl: await presign(r2, 'PUT', key, 600), url: `${publicUrl}/${key}` });
}
