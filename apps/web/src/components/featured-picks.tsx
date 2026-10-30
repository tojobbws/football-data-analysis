import { SignalCard, type SignalCardData } from '@/components/signal-card';
import { Section } from '@/components/ui';
import { FINISHED } from '@/lib/labels';
import type { MatchRow } from '@/lib/queries';

/** The day's listed matches as card data, best first (also what the home page ranks). */
export function featuredList(matches: MatchRow[], ranks: Map<number, number>): SignalCardData[] {
  return matches
    .filter((m) => ranks.has(m.id) && m.compass?.kind === 'SIGNAL' && !FINISHED.includes(m.status_short))
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!)
    .map((m) => ({
      slug: m.slug,
      league: m.league.name,
      kickoff_at: m.kickoff_at,
      home: m.home.name,
      away: m.away.name,
      home_logo: m.home.logo_url,
      away_logo: m.away.logo_url,
      market: m.compass!.market!,
      selection: m.compass!.selection!,
      line: m.compass!.line,
      signal_strength: m.compass!.signal_strength,
      model_probability: m.compass!.model_probability,
      market_probability: m.compass!.market_probability,
      odds_at_publish: m.compass!.odds_at_publish,
      round: m.compass!.publish_round,
    }));
}

/**
 * Finished matches that were คู่น่าจับตา: the day's ranked picks when there is a list, otherwise every pick.
 * They keep the gold frame after the whistle and show ถูก/ผิด.
 */
export function finishedWatch(matches: MatchRow[], ranks: Map<number, number>): string[] {
  return matches.filter((m) => FINISHED.includes(m.status_short) && m.compass?.kind === 'SIGNAL' && (!ranks.size || ranks.has(m.id))).map((m) => m.slug);
}

/**
 * Slugs that get the gold frame: the day's ranked list that has not started yet, plus the finished ones. No list yet
 * means no frame on a match still to play. One rule for the home page and /today.
 */
export function watchSlugs(matches: MatchRow[], ranks: Map<number, number>): Set<string> {
  return new Set([...featuredList(matches, ranks).map((f) => f.slug), ...finishedWatch(matches, ranks)]);
}

/** The day's list (เข็มทิศเกมประจำวัน, ADR 0006): the matches holding a slot, best first. Renders nothing when the list is empty. */
export function FeaturedPicks({ matches, ranks }: { matches: MatchRow[]; ranks: Map<number, number> }) {
  const listed = matches
    .filter((m) => ranks.has(m.id) && m.compass?.kind === 'SIGNAL' && !FINISHED.includes(m.status_short))
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
  if (!listed.length) return null;
  return (
    <Section title="เข็มทิศเกมประจำวัน" aside="คัดจากเข็มทิศเกมของวันนี้">
      <ul className="grid gap-3 sm:grid-cols-2">
        {listed.map((m) => (
          <li key={m.id}>
            <SignalCard
              s={{
                slug: m.slug,
                league: m.league.name,
                kickoff_at: m.kickoff_at,
                home: m.home.name,
                away: m.away.name,
                home_logo: m.home.logo_url,
                away_logo: m.away.logo_url,
                market: m.compass!.market!,
                selection: m.compass!.selection!,
                line: m.compass!.line,
                signal_strength: m.compass!.signal_strength,
                model_probability: m.compass!.model_probability,
                market_probability: m.compass!.market_probability,
                odds_at_publish: m.compass!.odds_at_publish,
                round: m.compass!.publish_round,
              }}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}
