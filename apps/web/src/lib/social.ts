/**
 * Rules for posting a finished film as a Reel (/admin/social). Pure: the admin page checks a draft with these as
 * the owner types, and the server checks them again before anything is sent to Meta.
 */

export const SOCIAL_CHANNELS = ['FACEBOOK', 'INSTAGRAM'] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

export const CHANNEL_LABEL: Record<SocialChannel, string> = { FACEBOOK: 'Facebook Reels', INSTAGRAM: 'Instagram Reels' };

/** What the film is: the films made in scripts/video, or anything else. */
export const SOCIAL_FORMATS = {
  SPOTLIGHT: 'คู่น่าจับตาวันนี้',
  RECAP: 'สรุปผลงานการทำนาย',
  INSIGHT: 'ข้อมูลที่เว็บอื่นไม่บอก',
  OTHER: 'อื่น ๆ',
} as const;
export type SocialFormat = keyof typeof SOCIAL_FORMATS;

/** Same words the site and the films keep out (packages/ai guards + the film scripts). */
export const CAPTION_BANNED = ['ทีเด็ด', 'แทงบอล', 'แทง', 'กำไร', 'ตามคู่นี้', 'การันตี', 'ฟันธง', 'ชัวร์', 'ได้เงิน', 'เสียเงิน'] as const;

/**
 * Meta's published limits for Reels made through the API (Facebook Reels Publishing API, Instagram Content
 * Publishing). A film outside them is refused by Meta after a full upload, so it is stopped here first.
 */
export const REEL_LIMITS: Record<SocialChannel, { minSeconds: number; maxSeconds: number; maxBytes: number; captionMax: number; hashtagMax: number }> = {
  FACEBOOK: { minSeconds: 3, maxSeconds: 90, maxBytes: 1024 ** 3, captionMax: 5000, hashtagMax: 30 },
  INSTAGRAM: { minSeconds: 3, maxSeconds: 15 * 60, maxBytes: 1024 ** 3, captionMax: 2200, hashtagMax: 30 },
};

export interface VideoInfo {
  name: string;
  bytes: number;
  seconds: number;
  width: number;
  height: number;
}

/** Problems that make a channel refuse the film (errors) or show it badly (warnings). */
export function checkVideo(v: VideoInfo, channel: SocialChannel): { errors: string[]; warnings: string[] } {
  const L = REEL_LIMITS[channel];
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/\.(mp4|mov)$/i.test(v.name)) errors.push('ต้องเป็นไฟล์ .mp4 หรือ .mov');
  if (!(v.bytes > 0)) errors.push('ไฟล์ว่าง');
  if (v.bytes > L.maxBytes) errors.push(`ไฟล์ใหญ่เกิน ${Math.round(L.maxBytes / 1024 ** 2)} MB`);
  if (v.seconds < L.minSeconds) errors.push(`สั้นเกินไป (ต่ำสุด ${L.minSeconds} วินาที)`);
  if (v.seconds > L.maxSeconds) errors.push(`ยาว ${Math.round(v.seconds)} วินาที เกินที่ ${CHANNEL_LABEL[channel]} รับ (${L.maxSeconds} วินาที)`);
  if (v.width && v.height) {
    const r = v.width / v.height;
    if (Math.abs(r - 9 / 16) > 0.02) warnings.push(`สัดส่วน ${v.width}x${v.height} ไม่ใช่ 9:16 จะมีขอบหรือถูกครอป`);
    if (v.height < 1280) warnings.push(`ความละเอียด ${v.width}x${v.height} ต่ำกว่า 720x1280`);
  }
  return { errors, warnings };
}

export function hashtags(caption: string): string[] {
  return caption.match(/#[^\s#]+/g) ?? [];
}

/** Caption problems for one channel: banned words, length, hashtag count. */
export function checkCaption(caption: string, channel: SocialChannel): string[] {
  const L = REEL_LIMITS[channel];
  const errors: string[] = [];
  const text = caption.trim();
  if (!text) errors.push('ต้องมีแคปชัน');
  for (const w of CAPTION_BANNED) if (text.includes(w)) errors.push(`มีคำต้องห้าม "${w}"`);
  if ([...text].length > L.captionMax) errors.push(`แคปชันยาวเกิน ${L.captionMax} ตัวอักษร (${CHANNEL_LABEL[channel]})`);
  if (hashtags(text).length > L.hashtagMax) errors.push(`แฮชแท็กเกิน ${L.hashtagMax} อัน (${CHANNEL_LABEL[channel]})`);
  return errors;
}

export type SocialStatus = 'DRAFT' | 'APPROVED' | 'UPLOADING' | 'PUBLISHING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'REJECTED';
export const STATUS_LABEL: Record<SocialStatus, string> = {
  DRAFT: 'ร่าง',
  APPROVED: 'อนุมัติแล้ว',
  UPLOADING: 'กำลังอัปโหลด',
  PUBLISHING: 'กำลังโพสต์',
  PROCESSING: 'Meta กำลังประมวลผล',
  PUBLISHED: 'โพสต์แล้ว',
  FAILED: 'ไม่สำเร็จ',
  REJECTED: 'ยกเลิก',
};
/** A post still moving: the page keeps asking the server about it. */
export const isOpen = (s: SocialStatus) => s === 'UPLOADING' || s === 'PUBLISHING' || s === 'PROCESSING';
