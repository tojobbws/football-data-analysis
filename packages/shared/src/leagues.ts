/**
 * Known API-Football league ids. Always confirm with `npm run sync:leagues`
 * (the job stores whatever the API returns for each id).
 */
export const KNOWN_LEAGUES = {
  39: { name: 'Premier League', country: 'England' },
  140: { name: 'La Liga', country: 'Spain' },
  135: { name: 'Serie A', country: 'Italy' },
  78: { name: 'Bundesliga', country: 'Germany' },
  61: { name: 'Ligue 1', country: 'France' },
  296: { name: 'Thai League 1', country: 'Thailand' },
  5: { name: 'UEFA Nations League', country: 'World' },
  2: { name: 'UEFA Champions League', country: 'World' },
  3: { name: 'UEFA Europa League', country: 'World' },
  848: { name: 'UEFA Europa Conference League', country: 'World' },
  1129: { name: 'ASEAN Club Championship', country: 'World' },
  // added 2026-10-15 for the daily featured list (.scratch/daily-featured)
  40: { name: 'Championship', country: 'England' },
  88: { name: 'Eredivisie', country: 'Netherlands' },
  94: { name: 'Primeira Liga', country: 'Portugal' },
  144: { name: 'Jupiler Pro League', country: 'Belgium' },
  203: { name: 'Süper Lig', country: 'Turkey' },
  179: { name: 'Premiership', country: 'Scotland' },
  119: { name: 'Superliga', country: 'Denmark' },
  218: { name: 'Bundesliga', country: 'Austria' },
  207: { name: 'Super League', country: 'Switzerland' },
  103: { name: 'Eliteserien', country: 'Norway' },
  113: { name: 'Allsvenskan', country: 'Sweden' },
  292: { name: 'K League 1', country: 'South-Korea' },
  98: { name: 'J1 League', country: 'Japan' },
  253: { name: 'Major League Soccer', country: 'USA' },
  262: { name: 'Liga MX', country: 'Mexico' },
  128: { name: 'Liga Profesional Argentina', country: 'Argentina' },
  307: { name: 'Pro League', country: 'Saudi-Arabia' },
  188: { name: 'A-League', country: 'Australia' },
} as const satisfies Record<number, { name: string; country: string }>;

/**
 * Club cups whose teams come from different domestic leagues -> those domestic leagues.
 * computeProbabilities blends in the cross-league model (packages/analysis/cross-league.ts) for these;
 * `sync:support` keeps results of the domestic leagues that are not in TRACKED_LEAGUES fresh
 * (results only, never shown on the site). Brunei has no league in API-Football.
 */
export const CROSS_LEAGUE_CUPS: Readonly<Record<number, readonly number[]>> = {
  // ASEAN Club Championship: TH, MY, SG, VN, ID, MM, KH, LA, PH
  1129: [296, 278, 368, 340, 274, 588, 410, 647, 765],
};

/** Fixture status codes from API-Football */
export const FIXTURE_STATUS = {
  NOT_STARTED: ['TBD', 'NS'],
  LIVE: ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'],
  FINISHED: ['FT', 'AET', 'PEN'],
  CANCELLED_OR_POSTPONED: ['PST', 'CANC', 'ABD', 'AWD', 'WO'],
} as const;

export const FINISHED_STATUSES: readonly string[] = FIXTURE_STATUS.FINISHED;
export const NOT_STARTED_STATUSES: readonly string[] = FIXTURE_STATUS.NOT_STARTED;
export const LIVE_STATUSES: readonly string[] = FIXTURE_STATUS.LIVE;
