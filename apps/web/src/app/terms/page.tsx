import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalContact, LegalPage, LegalSection, legalLink, legalList } from '@/components/legal';
import { SITE_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'ข้อกำหนดการใช้งาน',
  description: `เงื่อนไขการใช้${SITE_NAME}: บทวิเคราะห์เป็นข้อมูลและความบันเทิง ไม่ใช่คำแนะนำการพนัน และไม่รับประกันผลการแข่งขัน`,
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <LegalPage title="ข้อกำหนดการใช้งาน" updated="25 พฤศจิกายน 2569">
      <p>การใช้{SITE_NAME} ทั้งบนเว็บและคลิปบนโซเชียลของเรา ถือว่าคุณยอมรับข้อกำหนดในหน้านี้</p>

      <LegalSection title="1. บทวิเคราะห์คือข้อมูล ไม่ใช่คำรับประกัน">
        <ul className={legalList}>
          <li>บทวิเคราะห์ ตัวเลข และมุมมองของเข็มทิศเกม จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน</li>
          <li>การคาดการณ์ทุกอย่างเป็นความน่าจะเป็น ไม่มีโมเดลใดรับประกันผลการแข่งขันได้ เราแสดงผลงานย้อนหลังทั้งที่ถูกและผิดไว้ที่หน้า <Link href="/performance" className={legalLink}>ผลงานการวิเคราะห์</Link></li>
          <li>คุณรับผิดชอบการตัดสินใจของคุณเอง</li>
        </ul>
      </LegalSection>

      <LegalSection title="2. ความถูกต้องของข้อมูล">
        <p>
          ผลบอล สถิติ และรายชื่อผู้เล่นมาจากผู้ให้บริการข้อมูลฟุตบอลและระบบของเรา ซึ่งอาจล่าช้าหรือผิดพลาดได้ เมื่อพบข้อผิดพลาดเราจะแก้ไขโดยเร็ว
          แต่ไม่รับผิดชอบความเสียหายที่เกิดจากการนำข้อมูลไปใช้
        </p>
      </LegalSection>

      <LegalSection title="3. เนื้อหาของเรา">
        <ul className={legalList}>
          <li>บทความ กราฟิก และคลิปเป็นของ{SITE_NAME} แชร์ลิงก์หรือแชร์โพสต์ต่อได้เต็มที่</li>
          <li>ห้ามคัดลอกเนื้อหาจำนวนมาก ดึงข้อมูลอัตโนมัติ หรือนำไปเผยแพร่ซ้ำเชิงพาณิชย์โดยไม่ได้รับอนุญาต</li>
          <li>ชื่อทีม โลโก้ และภาพจากแหล่งอื่นเป็นของเจ้าของสิทธิ์นั้น ๆ</li>
        </ul>
      </LegalSection>

      <LegalSection title="4. โฆษณาและลิงก์ภายนอก">
        <p>
          แบนเนอร์ที่ติดป้าย &quot;โฆษณา&quot; มาจากผู้ลงโฆษณา ไม่ใช่การรับรองสินค้าหรือบริการ และไม่เกี่ยวกับมุมมองในบทวิเคราะห์ เว็บปลายทางของโฆษณาและลิงก์ภายนอกมีข้อกำหนดของตัวเอง
        </p>
      </LegalSection>

      <LegalSection title="5. คลิปบนโซเชียล">
        <p>
          คลิปของเราบน Facebook, Instagram และ YouTube อยู่ภายใต้ข้อกำหนดของแต่ละแพลตฟอร์มด้วย สำหรับ YouTube ดูได้ที่{' '}
          <a href="https://www.youtube.com/t/terms" className={legalLink} target="_blank" rel="noreferrer">ข้อกำหนดในการให้บริการของ YouTube</a>{' '}
          ส่วนการจัดการข้อมูลดูได้ที่ <Link href="/privacy" className={legalLink}>นโยบายความเป็นส่วนตัว</Link>
        </p>
      </LegalSection>

      <LegalSection title="6. การเปลี่ยนแปลงและกฎหมายที่ใช้">
        <p>เราอาจแก้ข้อกำหนดนี้ได้ และจะเปลี่ยนวันที่ด้านบนทุกครั้ง ข้อกำหนดนี้ใช้กฎหมายไทย</p>
        <LegalContact />
      </LegalSection>
    </LegalPage>
  );
}
