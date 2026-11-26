import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalContact, LegalPage, LegalSection, legalLink, legalList } from '@/components/legal';
import { SITE_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'นโยบายความเป็นส่วนตัว',
  description: `${SITE_NAME} เก็บข้อมูลอะไรบ้าง ใช้ทำอะไร และการใช้ YouTube API Services เพื่อโพสต์คลิปของเราเอง`,
  alternates: { canonical: '/privacy' },
};

/**
 * What the site actually collects (checked against the code, 2026-11-25): readers have no account; the only
 * cookies the site sets are the staff login on /admin; a banner click stores the banner and the time only.
 * Change this page when any of that changes.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="นโยบายความเป็นส่วนตัว" updated="25 พฤศจิกายน 2569">
      <p>
        หน้านี้อธิบายว่า{SITE_NAME}เก็บข้อมูลอะไรเมื่อคุณเข้าเว็บ เก็บไว้ทำอะไร และใครเห็นข้อมูลนั้นบ้าง เราเก็บเท่าที่เว็บต้องใช้ทำงานเท่านั้น
      </p>

      <LegalSection title="1. ผู้อ่านไม่ต้องสมัครสมาชิก">
        <p>อ่านบทวิเคราะห์ ผลบอล และผลงานย้อนหลังได้โดยไม่ต้องสมัครหรือเข้าสู่ระบบ เราจึงไม่เก็บชื่อ อีเมล หรือเบอร์โทรของผู้อ่าน</p>
      </LegalSection>

      <LegalSection title="2. ข้อมูลที่ระบบเห็นเมื่อคุณเข้าเว็บ">
        <ul className={legalList}>
          <li>
            เว็บทำงานบน Cloudflare ซึ่งเห็นที่อยู่ IP ประเภทเบราว์เซอร์ และหน้าที่เปิด เพื่อส่งหน้าเว็บและกันการโจมตี Cloudflare อาจใช้คุกกี้ทางเทคนิคเพื่อความปลอดภัย ข้อมูลส่วนนี้อยู่ภายใต้{' '}
            <a href="https://www.cloudflare.com/privacypolicy/" className={legalLink} target="_blank" rel="noreferrer">นโยบายของ Cloudflare</a>
          </li>
          <li>ตอนนี้เราไม่ได้ใช้เครื่องมือวัดสถิติหรือติดตามผู้ใช้ของบุคคลที่สาม และไม่ได้ตั้งคุกกี้โฆษณา</li>
          <li>คุกกี้ที่เว็บตั้งเองมีเพียงคุกกี้เข้าสู่ระบบของทีมงานในหน้าหลังบ้าน ผู้อ่านทั่วไปไม่ได้รับคุกกี้นี้</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. แบนเนอร์โฆษณา">
        <p>
          แบนเนอร์ติดป้าย &quot;โฆษณา&quot; เมื่อคุณกด เราบันทึกแค่ว่าแบนเนอร์ไหนถูกกดและเวลาที่กด เพื่อรายงานยอดคลิกให้ผู้ลงโฆษณา ไม่ได้บันทึก IP หรือข้อมูลที่ระบุตัวคุณ
          หลังจากนั้นคุณจะไปที่เว็บของผู้ลงโฆษณา ซึ่งใช้นโยบายความเป็นส่วนตัวของเขาเอง
        </p>
      </LegalSection>

      <LegalSection title="4. คลิปบนโซเชียลและ YouTube API Services">
        <p>
          เราโพสต์คลิปของเราเองลงเพจ Facebook, Instagram, ช่อง YouTube และบัญชี TikTok ของ{SITE_NAME} จากหน้าหลังบ้านของเว็บ การโพสต์ลง YouTube ใช้ YouTube API Services
        </p>
        <ul className={legalList}>
          <li>เราใช้ YouTube API Services เพื่ออัปโหลดคลิปลงช่องของเราเองและเช็กสถานะคลิปเท่านั้น ไม่ได้เข้าถึง อ่าน หรือเก็บข้อมูลบัญชี YouTube ของผู้ชม</li>
          <li>
            การดูคลิปบน YouTube เป็นไปตาม{' '}
            <a href="https://www.youtube.com/t/terms" className={legalLink} target="_blank" rel="noreferrer">ข้อกำหนดในการให้บริการของ YouTube</a> และ{' '}
            <a href="https://policies.google.com/privacy" className={legalLink} target="_blank" rel="noreferrer">นโยบายความเป็นส่วนตัวของ Google</a>
          </li>
          <li>
            สิทธิ์ที่เว็บได้รับจากบัญชี Google ของเจ้าของช่อง ถอนได้ทุกเมื่อที่{' '}
            <a href="https://security.google.com/settings/security/permissions" className={legalLink} target="_blank" rel="noreferrer">หน้าการตั้งค่าความปลอดภัยของ Google</a>
          </li>
          <li>คลิปบน Facebook และ Instagram เป็นไปตามนโยบายของ Meta</li>
          <li>
            TikTok: เราใช้ TikTok Content Posting API ส่งคลิปของเราเองเข้า Inbox ของบัญชี TikTok ของเรา แล้วเจ้าของบัญชีกดโพสต์เองในแอป เราเก็บเฉพาะ token
            ของบัญชีเราเองและชื่อบัญชีที่แสดง ไม่ได้เข้าถึงหรือเก็บข้อมูลของผู้ชมบน TikTok การดูคลิปบน TikTok เป็นไปตาม{' '}
            <a href="https://www.tiktok.com/legal/page/row/terms-of-service/th-TH" className={legalLink} target="_blank" rel="noreferrer">ข้อกำหนดในการให้บริการของ TikTok</a> และ{' '}
            <a href="https://www.tiktok.com/legal/page/row/privacy-policy/th-TH" className={legalLink} target="_blank" rel="noreferrer">นโยบายความเป็นส่วนตัวของ TikTok</a>
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="5. สิทธิของคุณ">
        <p>
          ตามพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 คุณขอดู ขอแก้ หรือขอให้ลบข้อมูลส่วนบุคคลที่เราถืออยู่ได้ แม้ว่าเราแทบไม่ได้เก็บข้อมูลที่ระบุตัวผู้อ่านก็ตาม
        </p>
        <LegalContact />
      </LegalSection>

      <LegalSection title="6. การเปลี่ยนแปลง">
        <p>
          ถ้าเราเริ่มเก็บข้อมูลแบบใหม่ เช่น เพิ่มเครื่องมือวัดสถิติ เราจะแก้หน้านี้และวันที่ด้านบนก่อนเริ่มใช้ ดูเงื่อนไขการใช้เว็บได้ที่{' '}
          <Link href="/terms" className={legalLink}>ข้อกำหนดการใช้งาน</Link>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
