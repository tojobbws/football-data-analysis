import Link from 'next/link';

/** The one-line framing of the Game Compass, shared by every place that introduces it. */
export const COMPASS_LINE = '1 ตัวเลือกต่อคู่ ตรงจุดที่โมเดลมองต่างจากตลาดชัดที่สุด · ล็อกก่อนเตะ';

/** Under the เข็มทิศเกม คู่น่าจับตา title on the home page. */
export const COMPASS_HOME_LINE = 'คู่ที่โมเดลมองต่างจากตลาดชัดที่สุด คู่ละ 1 ตัวเลือก ล็อกก่อนเตะ แก้ไขไม่ได้ และวัดผลให้ดูทุกคู่';

/** "เลือกยังไง?" — tap to unfold why the Game Compass follows the gap with the market, not the likeliest result. */
export function CompassExplainer({ className = '' }: { className?: string }) {
  return (
    <details className={`group text-xs ${className}`}>
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center font-medium text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
        เลือกยังไง?
      </summary>
      <p className="mt-1 max-w-prose rounded-lg bg-zinc-50 p-3 text-[13px] leading-relaxed text-zinc-700">
        ตลาดฟุตบอลมีความเห็นรวมอยู่แล้วว่าแต่ละตัวเลือกมีโอกาสเกิดแค่ไหน ถ้าโมเดลของเราคิดเหมือนตลาด ก็ไม่มีอะไรใหม่ให้บอก
        เข็มทิศเกมจึงไม่ได้บอกว่าอะไรน่าจะเกิดที่สุด แต่เลือกจุดที่โมเดลมองต่างจากตลาดชัดที่สุดเพียงจุดเดียว
        ถ้าต่างกันมากผิดปกติ เราถือว่าโมเดลอาจพลาดข้อมูลบางอย่าง จึงไม่เลือก ทุกตัวเลือกล็อกก่อนเตะ แก้ไขไม่ได้ และวัดผลให้ดูที่{' '}
        <Link href="/performance" className="font-medium text-zinc-950 underline underline-offset-2">
          หน้าผลงาน
        </Link>
      </p>
    </details>
  );
}
