import type { ReactNode } from 'react';

// Building blocks with no server-only imports, so client components can use them too.

export function Section({ title, aside, children, className = '' }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside ? <div className="text-xs text-slate-500">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function TeamLogo({ src, alt, size = 24 }: { src: string | null; alt: string; size?: number }) {
  if (!src) return <span className="inline-block rounded-full bg-slate-200" style={{ width: size, height: size }} aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} width={size} height={size} loading="lazy" className="inline-block shrink-0 object-contain" style={{ width: size, height: size }} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{children}</p>;
}
