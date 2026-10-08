'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Horizontal scroller that brings its `aria-current` child to the centre on load. */
export function ScrollToCurrent({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const cur = box?.querySelector<HTMLElement>('[aria-current]');
    if (box && cur) box.scrollLeft = cur.offsetLeft - box.offsetLeft - (box.clientWidth - cur.offsetWidth) / 2;
  });
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
