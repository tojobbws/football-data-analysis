import { MatchList } from '@/components/match-list';
import { Section } from '@/components/ui';
import type { MatchRow } from '@/lib/queries';

/** ฟุตบอลไทย: the day's matches in the leagues the registry flags as Thai. Renders nothing when there are none. */
export function ThaiMatches({ matches }: { matches: MatchRow[] }) {
  if (!matches.length) return null;
  return (
    <Section title="ฟุตบอลไทย" aside={`${matches.length} คู่`}>
      <MatchList matches={matches} />
    </Section>
  );
}
