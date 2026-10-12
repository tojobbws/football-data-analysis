/**
 * Shown the moment a link is clicked while the next page reads the database (every page is dynamic,
 * a few round trips each). The header stays; this fills the page area in the same light sheet.
 */
export default function Loading() {
  return (
    <div className="bg-white" role="status" aria-live="polite">
      <span className="sr-only">กำลังโหลด…</span>
      <div className="mx-auto max-w-5xl animate-pulse px-4 pb-12 pt-5 motion-reduce:animate-none sm:pt-8" aria-hidden>
        <div className="h-3 w-48 rounded bg-slate-100" />
        <div className="mt-6 h-8 w-2/3 max-w-md rounded bg-slate-100" />
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200/80" />
            ))}
          </div>
          <div className="hidden space-y-3 lg:block">
            <div className="h-40 rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200/80" />
            <div className="h-56 rounded-xl bg-slate-50 ring-1 ring-inset ring-slate-200/80" />
          </div>
        </div>
      </div>
    </div>
  );
}
