import { BANNER_IMAGES, WIDE_MIN_SCREEN, type Banner } from '@/lib/banners';

/**
 * One home-page banner (ADR 0024): the wide picture from 640 px up, the phone picture below, always labelled โฆษณา.
 * The link goes through /go/<id>, which counts the click and redirects. Nothing renders when the slot is empty.
 */
export function BannerSlot({ banner, eager = false, className = '' }: { banner?: Banner; eager?: boolean; className?: string }) {
  if (!banner) return null;
  const { wide, phone } = BANNER_IMAGES;
  return (
    <aside aria-label="โฆษณา" className={className}>
      <a href={`/go/${banner.id}`} target="_blank" rel="sponsored noopener" className="group relative block overflow-hidden rounded-xl ring-1 ring-inset ring-slate-200/80">
        <picture>
          <source media={`(min-width: ${WIDE_MIN_SCREEN}px)`} srcSet={banner.imageWide} width={wide.width} height={wide.height} />
          {/* eslint-disable-next-line @next/next/no-img-element -- pictures on our own R2 domain; next/image adds nothing here */}
          <img
            src={banner.imagePhone}
            width={phone.width}
            height={phone.height}
            alt={banner.alt}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            className="block h-auto w-full transition-opacity group-hover:opacity-95"
          />
        </picture>
        <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">โฆษณา</span>
      </a>
    </aside>
  );
}
