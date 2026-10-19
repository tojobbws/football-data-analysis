import { MatchItem, MatchList } from '@/components/match-list';
import { Section } from '@/components/ui';
import type { BigMatch } from '@/lib/popularity';
import type { MatchRow } from '@/lib/queries';

/**
 * คู่ใหญ่: the matches readers are most likely to care about, whether or not they have a เข็มทิศเกม.
 * Ordered by popularity (teams, league, rivalry), which says nothing about who is likely to win.
 * Renders nothing when no match qualifies.
 */
export function BigMatches({ items, title = 'คู่ใหญ่' }: { items: BigMatch[]; title?: string }) {
  if (!items.length) return null;
  return (
    <Section title={title} aside="เรียงตามความน่าสนใจ ไม่เกี่ยวกับโอกาสของผล">
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {items.map(({ match, derby }) => (
          <MatchItem key={match.id} m={match} compact note={[match.league.name, derby].filter(Boolean).join(' · ')} />
        ))}
      </ul>
    </Section>
  );
}

/** ฟุตบอลไทย: the day's matches in the leagues the registry flags as Thai. Renders nothing when there are none. */
export function ThaiMatches({ matches }: { matches: MatchRow[] }) {
  if (!matches.length) return null;
  return (
    <Section title="ฟุตบอลไทย" aside={`${matches.length} คู่`}>
      <MatchList matches={matches} />
    </Section>
  );
}
