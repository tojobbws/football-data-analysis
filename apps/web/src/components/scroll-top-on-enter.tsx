'use client';

import { useEffect } from 'react';

/**
 * Enter the page at the top, wherever the previous page was scrolled to (footer link, back/forward
 * restore) and even when the URL carries a `#hash`. Runs on mount only, so the date strip's
 * `scroll={false}` links keep their position. The timers cover the browser's own hash jump, which
 * can land after mount.
 */
export function ScrollTopOnEnter() {
  useEffect(() => {
    const top = () => window.scrollTo(0, 0);
    top();
    window.addEventListener('load', top, { once: true });
    const t = window.setTimeout(top, 300);
    return () => {
      window.removeEventListener('load', top);
      window.clearTimeout(t);
    };
  }, []);
  return null;
}
