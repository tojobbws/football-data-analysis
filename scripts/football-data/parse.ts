/**
 * Readers for the two football-data.co.uk CSV layouts, both turned into the same shape.
 *
 * main  - one league per file, one season per file (E0_2425.csv, SP1_2425.csv ...):
 *         HomeTeam/AwayTeam, early and closing odds, 1X2 + over/under 2.5 + Asian handicap.
 * extra - "other leagues" files (USA_MLS.csv ...): one league per file, all seasons,
 *         Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA,MaxCH..,AvgCH..,B365CH..
 *         Only 1X2 closing prices are in these files (checked against USA_MLS.csv).
 */
import { readFileSync } from 'node:fs';

export type Phase = 'early' | 'close';

export interface Price {
  bookmaker: string;
  phase: Phase;
  market: 'MATCH_WINNER' | 'ASIAN_HANDICAP' | 'OVER_UNDER';
  selection: string;
  line: number | null;
  odds: number;
}

export interface ParsedMatch {
  home: string;
  away: string;
  kickoffMs: number;
  prices: Price[];
}

export interface ParsedFile {
  format: 'main' | 'extra';
  matches: ParsedMatch[];
  /** extra files only: every Country value seen, so a wrong --country can be reported. */
  countries: string[];
}

interface Spec {
  bookmaker: string;
  phase: Phase;
  cols: string[];
}

// Pinnacle columns are PS* up to 2025/26 and PP* after; a spec is skipped when its columns are not in the file.
const X12: Spec[] = [
  { bookmaker: 'PIN', phase: 'early', cols: ['PSH', 'PSD', 'PSA'] },
  { bookmaker: 'PIN', phase: 'early', cols: ['PPH', 'PPD', 'PPA'] },
  { bookmaker: 'PIN', phase: 'close', cols: ['PSCH', 'PSCD', 'PSCA'] },
  { bookmaker: 'PIN', phase: 'close', cols: ['PPCH', 'PPCD', 'PPCA'] },
  { bookmaker: 'B365', phase: 'early', cols: ['B365H', 'B365D', 'B365A'] },
  { bookmaker: 'B365', phase: 'close', cols: ['B365CH', 'B365CD', 'B365CA'] },
  { bookmaker: 'AVG', phase: 'early', cols: ['AvgH', 'AvgD', 'AvgA'] },
  { bookmaker: 'AVG', phase: 'close', cols: ['AvgCH', 'AvgCD', 'AvgCA'] },
  { bookmaker: 'MAX', phase: 'early', cols: ['MaxH', 'MaxD', 'MaxA'] },
  { bookmaker: 'MAX', phase: 'close', cols: ['MaxCH', 'MaxCD', 'MaxCA'] },
];
const OU: Spec[] = [
  { bookmaker: 'PIN', phase: 'early', cols: ['P>2.5', 'P<2.5'] },
  { bookmaker: 'PIN', phase: 'close', cols: ['PC>2.5', 'PC<2.5'] },
  { bookmaker: 'B365', phase: 'early', cols: ['B365>2.5', 'B365<2.5'] },
  { bookmaker: 'B365', phase: 'close', cols: ['B365C>2.5', 'B365C<2.5'] },
  { bookmaker: 'AVG', phase: 'early', cols: ['Avg>2.5', 'Avg<2.5'] },
  { bookmaker: 'AVG', phase: 'close', cols: ['AvgC>2.5', 'AvgC<2.5'] },
  { bookmaker: 'MAX', phase: 'early', cols: ['Max>2.5', 'Max<2.5'] },
  { bookmaker: 'MAX', phase: 'close', cols: ['MaxC>2.5', 'MaxC<2.5'] },
];
const AH: Spec[] = [
  { bookmaker: 'PIN', phase: 'early', cols: ['PAHH', 'PAHA'] },
  { bookmaker: 'PIN', phase: 'close', cols: ['PCAHH', 'PCAHA'] },
  { bookmaker: 'B365', phase: 'early', cols: ['B365AHH', 'B365AHA'] },
  { bookmaker: 'B365', phase: 'close', cols: ['B365CAHH', 'B365CAHA'] },
  { bookmaker: 'AVG', phase: 'early', cols: ['AvgAHH', 'AvgAHA'] },
  { bookmaker: 'AVG', phase: 'close', cols: ['AvgCAHH', 'AvgCAHA'] },
  { bookmaker: 'MAX', phase: 'early', cols: ['MaxAHH', 'MaxAHA'] },
  { bookmaker: 'MAX', phase: 'close', cols: ['MaxCAHH', 'MaxCAHA'] },
];
// extra files: 1X2 closing prices only
// (current files name them PSCH/MaxCH/AvgCH/B365CH; older layouts used PH/MaxH/AvgH, kept as fallbacks)
const EXTRA_X12: Spec[] = [
  { bookmaker: 'PIN', phase: 'close', cols: ['PSCH', 'PSCD', 'PSCA'] },
  { bookmaker: 'PIN', phase: 'close', cols: ['PH', 'PD', 'PA'] },
  { bookmaker: 'MAX', phase: 'close', cols: ['MaxCH', 'MaxCD', 'MaxCA'] },
  { bookmaker: 'MAX', phase: 'close', cols: ['MaxH', 'MaxD', 'MaxA'] },
  { bookmaker: 'AVG', phase: 'close', cols: ['AvgCH', 'AvgCD', 'AvgCA'] },
  { bookmaker: 'AVG', phase: 'close', cols: ['AvgH', 'AvgD', 'AvgA'] },
  { bookmaker: 'B365', phase: 'close', cols: ['B365CH', 'B365CD', 'B365CA'] },
];

const num = (v: string | undefined) => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Split one CSV line, honouring "quoted, fields". */
function splitLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function readRows(file: string): { head: string[]; rows: Record<string, string>[] } {
  const lines = readFileSync(file, 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const head = splitLine(lines[0]!).map((h) => h.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = splitLine(l);
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
  return { head, rows };
}

/** dd/mm/yyyy (or yy) + HH:MM -> UTC ms. Times are local to the league, so an hour or two of error is expected. */
export function kickoffMs(date: string, time: string): number {
  const [d, m, y] = date.split('/').map(Number) as [number, number, number];
  const [hh, mm] = (time || '12:00').split(':').map(Number) as [number, number];
  return Date.UTC(y < 100 ? 2000 + y : y, m - 1, d, hh || 0, mm || 0);
}

function pricesFor(r: Record<string, string>, specs: Spec[], market: Price['market'], selections: string[]): Price[] {
  const out: Price[] = [];
  for (const s of specs) {
    if (!(s.cols[0]! in r)) continue;
    s.cols.forEach((c, i) => {
      const odds = num(r[c]);
      if (odds === null || odds <= 1) return;
      out.push({ bookmaker: s.bookmaker, phase: s.phase, market, selection: selections[i]!, line: market === 'OVER_UNDER' ? 2.5 : null, odds });
    });
  }
  return out;
}

function ahPrices(r: Record<string, string>): Price[] {
  const out: Price[] = [];
  for (const s of AH) {
    if (!(s.cols[0]! in r)) continue;
    const h = num(r[s.phase === 'early' ? 'AHh' : 'AHCh']);
    if (h === null) continue;
    s.cols.forEach((c, i) => {
      const odds = num(r[c]);
      if (odds === null || odds <= 1) return;
      const home = i === 0;
      out.push({ bookmaker: s.bookmaker, phase: s.phase, market: 'ASIAN_HANDICAP', selection: home ? 'HOME' : 'AWAY', line: home ? h : h === 0 ? 0 : -h, odds });
    });
  }
  return out;
}

export interface ParseOptions {
  /** extra files: keep only rows of this Country (case-insensitive). */
  country?: string;
}

export function parseFile(file: string, opts: ParseOptions = {}): ParsedFile {
  const { head, rows } = readRows(file);
  const has = (c: string) => head.includes(c);

  if (has('HomeTeam') && has('AwayTeam')) {
    const matches: ParsedMatch[] = [];
    for (const r of rows) {
      if (!r.HomeTeam || !r.Date) continue;
      matches.push({
        home: r.HomeTeam,
        away: r.AwayTeam!,
        kickoffMs: kickoffMs(r.Date, r.Time!),
        prices: [
          ...pricesFor(r, X12, 'MATCH_WINNER', ['HOME', 'DRAW', 'AWAY']),
          ...pricesFor(r, OU, 'OVER_UNDER', ['OVER', 'UNDER']),
          ...ahPrices(r),
        ],
      });
    }
    return { format: 'main', matches, countries: [] };
  }

  if (has('Home') && has('Away') && has('Country') && has('Date')) {
    const countries = [...new Set(rows.map((r) => r.Country!).filter(Boolean))].sort();
    const want = opts.country?.toLowerCase();
    const matches: ParsedMatch[] = [];
    for (const r of rows) {
      if (!r.Home || !r.Date) continue;
      if (want && r.Country!.toLowerCase() !== want) continue;
      matches.push({
        home: r.Home,
        away: r.Away!,
        kickoffMs: kickoffMs(r.Date, r.Time!),
        prices: pricesFor(r, EXTRA_X12, 'MATCH_WINNER', ['HOME', 'DRAW', 'AWAY']),
      });
    }
    return { format: 'extra', matches, countries };
  }

  throw new Error(`${file}: unknown football-data layout (columns: ${head.slice(0, 12).join(', ')} ...)`);
}
