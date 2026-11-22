/**
 * Which match pages search engines should index (owner, 2026-11-22). A match page that is over and never
 * got a Thai write-up holds only numbers that every stats site has: Google left such pages out (Search
 * Console 4–20 Nov 2026: 56 of the 58 match pages with impressions had a write-up, the other 2 earned 3
 * impressions), and thousands of them weigh on how Google rates the site. Those pages get `noindex,
 * follow` and leave the sitemap; the page itself stays for readers.
 *
 * An upcoming match stays indexed without a write-up: about 95% of matches get one before kickoff, and
 * the page is what fans search for before the game.
 */

/** Hours after kickoff before a page without a write-up counts as thin (a write-up never comes after the game). */
export const THIN_AFTER_HOURS = 24;

export function isThinMatchPage(kickoffAt: string, hasWriteUp: boolean, now = Date.now()): boolean {
  if (hasWriteUp) return false;
  return new Date(kickoffAt).getTime() + THIN_AFTER_HOURS * 3_600_000 < now;
}
