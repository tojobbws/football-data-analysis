/**
 * Home-page banners (ADR 0024, .scratch/banners/spec.md): the pure rules, shared by the page, the /go redirect and
 * /admin/banners. A banner is one picture pair (wide for screens >= 640 px, phone below) shown in up to three slots.
 */

export const BANNER_SLOTS = ['home_top', 'home_league_1', 'home_league_2'] as const;
export type BannerSlot = (typeof BANNER_SLOTS)[number];

export const SLOT_LABEL: Record<BannerSlot, string> = {
  home_top: 'บนสุด (ก่อนแมตช์วันนี้)',
  home_league_1: 'ระหว่างลีก 1 (หลังลีกที่ 2)',
  home_league_2: 'ระหว่างลีก 2 (หลังลีกที่ 5)',
};

/** The league groups of the scoreboard that a between-league slot follows (1-based). */
export const LEAGUE_SLOT_AFTER: Record<Exclude<BannerSlot, 'home_top'>, number> = { home_league_1: 2, home_league_2: 5 };

/** The two pictures: file size in pixels; the wide one shows from WIDE_MIN_SCREEN px up. */
export const BANNER_IMAGES = {
  wide: { width: 1340, height: 200, label: 'ภาพ web' },
  phone: { width: 1080, height: 360, label: 'ภาพ mobile' },
} as const;
export type BannerImageKind = keyof typeof BANNER_IMAGES;
export const WIDE_MIN_SCREEN = 640;
export const BANNER_MAX_BYTES = 300 * 1024;
export const BANNER_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

export interface Banner {
  id: number;
  name: string;
  imageWide: string;
  imagePhone: string;
  alt: string;
  target: string;
  slots: BannerSlot[];
  priority: number;
}

export type SlotBanners = Partial<Record<BannerSlot, Banner>>;

/**
 * Which banner each slot shows: the highest priority (then the newest) among those listing it, and never the same
 * banner twice on a page — a lower slot falls to its next banner. `banners` are the ones that may show now.
 */
export function chooseBanners(banners: Banner[]): SlotBanners {
  const ranked = [...banners].sort((a, b) => b.priority - a.priority || b.id - a.id);
  const used = new Set<number>();
  const out: SlotBanners = {};
  for (const slot of BANNER_SLOTS) {
    const b = ranked.find((x) => x.slots.includes(slot) && !used.has(x.id));
    if (b) {
      out[slot] = b;
      used.add(b.id);
    }
  }
  return out;
}

/** The between-league slot that follows league group `index` (0-based) of `total`, if one does and a league follows. */
export function slotAfterLeague(index: number, total: number): BannerSlot | null {
  if (index >= total - 1) return null;
  for (const [slot, after] of Object.entries(LEAGUE_SLOT_AFTER)) if (index + 1 === after) return slot as BannerSlot;
  return null;
}

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|curl|wget|python-requests|axios|node-fetch/i;

/** Clicks from known bots and link previewers are not counted (an empty User-Agent is treated as a bot). */
export const isBot = (userAgent: string | null | undefined) => !userAgent || BOT.test(userAgent);

/** An https link with a host, or null. */
export function httpsUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' && u.hostname.includes('.') ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A picture's size is accepted when its ratio is within 1 % of the target and it is at least as large. */
export function checkImageSize(kind: BannerImageKind, width: number, height: number): string | null {
  const t = BANNER_IMAGES[kind];
  const ratio = width / height;
  const want = t.width / t.height;
  if (!width || !height || Math.abs(ratio - want) / want > 0.01) return `${t.label} ต้องเป็นสัดส่วน ${t.width}×${t.height} (ได้ ${width}×${height})`;
  if (width < t.width) return `${t.label} เล็กเกินไป ต้องกว้างอย่างน้อย ${t.width}px (ได้ ${width}px)`;
  return null;
}

/** The checks on a picture file before upload: type and bytes. */
export function checkImageFile(kind: BannerImageKind, type: string, bytes: number): string | null {
  const t = BANNER_IMAGES[kind];
  if (!(type in BANNER_TYPES)) return `${t.label} ต้องเป็น JPG, WebP หรือ PNG`;
  if (bytes > BANNER_MAX_BYTES) return `${t.label} ใหญ่เกิน 300KB (${Math.round(bytes / 1024)}KB)`;
  return null;
}

/** Where an uploaded picture lives in the public bucket: unguessable, never overwritten. */
export function bannerKey(kind: BannerImageKind, type: string): string {
  return `b/${kind}/${crypto.randomUUID()}.${BANNER_TYPES[type] ?? 'jpg'}`;
}

/** A Thai wall-clock 'YYYY-MM-DDTHH:mm' (datetime-local) as an ISO instant, or null. */
export function thaiLocalToIso(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}:00+07:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** An instant as the Thai wall-clock 'YYYY-MM-DDTHH:mm' a datetime-local input shows. */
export function isoToThaiLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(Date.parse(iso) + 7 * 3600_000).toISOString().slice(0, 16);
}
