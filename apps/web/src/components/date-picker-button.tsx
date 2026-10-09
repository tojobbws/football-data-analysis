'use client';

import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { IconCalendar } from './icons';

/** Round calendar button: opens the native date picker and goes to that day. */
export function DatePickerButton({ value, base }: { value: string; base: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          const el = input.current;
          if (!el) return;
          try {
            el.showPicker();
          } catch {
            el.focus();
            el.click();
          }
        }}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-[var(--color-ink)] transition-colors duration-150 hover:bg-slate-200"
        aria-label="เลือกวันที่จากปฏิทิน"
      >
        <IconCalendar size={20} />
      </button>
      <input
        ref={input}
        type="date"
        tabIndex={-1}
        aria-hidden
        defaultValue={value}
        onChange={(e) => {
          if (e.target.value) router.push(`${base}?date=${e.target.value}`, { scroll: false });
        }}
        className="pointer-events-none absolute bottom-0 right-0 h-px w-px opacity-0"
      />
    </div>
  );
}
