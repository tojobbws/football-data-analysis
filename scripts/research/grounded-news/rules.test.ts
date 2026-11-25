import { describe, expect, it } from 'vitest';
import { bingTargetUrl, parseRobots, parseRssItems, robotsAllows } from './fetch.js';
import {
  canonicalUrl,
  chooseTimestamp,
  extractParagraphs,
  impact,
  mentionsTeam,
  novelty,
  pageTimestamps,
  quoteVerified,
  resolvePlayer,
  selectExcerpt,
  signalStatus,
  sourceTier,
  trimQuote,
  type StatusInput,
} from './rules.js';
import { CATEGORY_FIELD, ExtractedSignalSchema, NEWS_CATEGORIES, NEWS_OUTPUT_SCHEMA, type ExtractedSignal } from './schema.js';

const base: ExtractedSignal = {
  article_id: 'A1',
  team: 'HOME',
  category: 'LATE_INJURY_OR_ILLNESS',
  player_name_as_written: 'Gabriel Jesus',
  severity: 'OUT',
  eligibility: null,
  rotation_strength: null,
  rotation_scope: null,
  manager_change: null,
  disruption: null,
  attribution: 'MANAGER_OR_PLAYER_QUOTE',
  certainty_in_text: 'CONFIRMED',
  evidence_quote: 'Arteta confirmed Jesus will miss the game',
  fact_en: 'The manager confirmed the striker will miss the match',
};

describe('schema', () => {
  it('accepts a well-formed signal', () => expect(ExtractedSignalSchema.safeParse(base).success).toBe(true));
  it('rejects digits in fact_en', () => expect(ExtractedSignalSchema.safeParse({ ...base, fact_en: 'He is out for 3 weeks with a knock' }).success).toBe(false));
  it('rejects a category field set on the wrong category', () => expect(ExtractedSignalSchema.safeParse({ ...base, rotation_strength: 'HINTED' }).success).toBe(false));
  it('rejects a player name on a team-level category', () =>
    expect(ExtractedSignalSchema.safeParse({ ...base, category: 'MANAGER_CHANGE', severity: null, manager_change: 'SACKED' }).success).toBe(false));
  it('rejects a quote over 200 characters', () => expect(ExtractedSignalSchema.safeParse({ ...base, evidence_quote: 'x'.repeat(201) }).success).toBe(false));
  it('JSON schema is strict: every property required, enums match the Zod ones', () => {
    const items = NEWS_OUTPUT_SCHEMA.properties.signals.items;
    expect([...items.required].sort()).toEqual(Object.keys(items.properties).sort());
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.category.enum).toEqual([...NEWS_CATEGORIES]);
    for (const field of Object.values(CATEGORY_FIELD)) expect((items.properties[field] as { enum: unknown[] }).enum).toContain(null);
  });
});

describe('quoteVerified', () => {
  const text = 'O técnico confirmou: “Ele está fora do jogo de domingo”, disse.\n\nOutro parágrafo.';
  it('matches a verbatim passage despite curly quotes and spacing', () => expect(quoteVerified('"Ele está fora do jogo   de domingo"', text)).toBe(true));
  it('refuses a paraphrase', () => expect(quoteVerified('Ele não joga no domingo', text)).toBe(false));
  it('refuses a passage joined across paragraphs', () => expect(quoteVerified('disse. Outro parágrafo inventado', text)).toBe(false));
  it('a quote just over 200 characters is cut at a word and stays verbatim', () => {
    const long = `${'palavra '.repeat(26)}fim`;
    const t = trimQuote({ ...base, evidence_quote: long });
    const q = (t.raw as ExtractedSignal).evidence_quote;
    expect(t.trimmed).toBe(true);
    expect(q.length).toBeLessThanOrEqual(200);
    expect(quoteVerified(q, long)).toBe(true);
    expect(trimQuote(base)).toEqual({ raw: base, trimmed: false });
  });
});

describe('HTML', () => {
  const html = `<html><head><meta property="article:published_time" content="2026-11-24T06:40:00.000-03:00"><script type="application/ld+json">{"dateModified": "2026-11-24T10:00:00+0000"}</script></head>
  <body><nav><p>Menu menu menu menu menu menu menu menu</p></nav><p>First paragraph about Grêmio and the &quot;game&quot; on Sunday.</p><script>var p = "<p>no</p>"</script><p>Short</p><p>Second paragraph says Weverton trained apart today.</p></body></html>`;
  it('reads meta and JSON-LD timestamps (+0000 offsets too)', () => {
    const t = pageTimestamps(html);
    expect(t.published?.toISOString()).toBe('2026-11-24T09:40:00.000Z');
    expect(t.modified?.toISOString()).toBe('2026-11-24T10:00:00.000Z');
  });
  it('keeps body paragraphs, drops nav, script and short ones, decodes entities', () =>
    expect(extractParagraphs(html)).toEqual(['First paragraph about Grêmio and the "game" on Sunday.', 'Second paragraph says Weverton trained apart today.']));
  it('excerpt keeps the first paragraphs and keyword paragraphs', () => {
    const ps = ['a'.repeat(40), 'b'.repeat(40), 'nothing here at all, just filler text', 'Weverton is a doubt for the match'];
    expect(selectExcerpt(ps, ['Weverton'])).toBe([ps[0], ps[1], ps[3]].join('\n\n'));
  });
});

describe('timestamps', () => {
  const page = new Date('2026-11-24T05:00:00Z');
  it('page metadata wins', () => expect(chooseTimestamp(page, new Date('2026-11-24T06:00:00Z'))).toEqual({ published: page, basis: 'PAGE_META' }));
  it('a disagreement over three hours takes the later time', () => expect(chooseTimestamp(page, new Date('2026-11-24T12:00:00Z')).published?.toISOString()).toBe('2026-11-24T12:00:00.000Z'));
  it('feed only is flagged', () => expect(chooseTimestamp(null, page).basis).toBe('RSS_ONLY'));
  it('none', () => expect(chooseTimestamp(null, null)).toEqual({ published: null, basis: 'NONE' }));
});

describe('URLs, sources, teams', () => {
  it('canonical URL drops tracking, www, amp and the hash', () => expect(canonicalUrl('https://www.site.com/news/x/amp/?utm_source=a&id=3#top')).toBe('https://site.com/news/x?id=3'));
  it('Bing click link gives the publisher URL', () =>
    expect(bingTargetUrl('http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fwww.lance.com.br%2fa.html&c=1')).toBe('https://www.lance.com.br/a.html'));
  it('tiers', () => {
    expect(sourceTier('skysports.com', ['Arsenal'])).toBe('reputable_media');
    expect(sourceTier('ge.globo', ['Gremio'])).toBe('reputable_media');
    expect(sourceTier('arsenal.com', ['Arsenal'])).toBe('official_club');
    expect(sourceTier('gremio.net', ['Grêmio'])).toBe('official_club');
    expect(sourceTier('msn.com', ['Arsenal'])).toBe('aggregator');
    expect(sourceTier('randomblog.net', ['Arsenal'])).toBe('aggregator');
  });
  it('team mention needs a distinctive word, not "United" alone', () => {
    expect(mentionsTeam('Manchester news today', 'Manchester United')).toBe(true);
    expect(mentionsTeam('United fans celebrate', 'Manchester United')).toBe(false);
    expect(mentionsTeam('O Grêmio venceu', 'Gremio')).toBe(true);
  });
  it('RSS items', () => {
    const xml = '<rss><channel><item><title>A &amp; B</title><link>http://x.com/a</link><pubDate>Mon, 23 Nov 2026 22:39:00 GMT</pubDate></item></channel></rss>';
    expect(parseRssItems(xml)).toEqual([{ title: 'A & B', link: 'http://x.com/a', pubDate: new Date('2026-11-23T22:39:00Z'), source: null, sourceUrl: null }]);
  });
  it('robots.txt: only the * group applies, the longest rule wins', () => {
    const d = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /\nDisallow: /*?\nAllow: /private/ok$\n');
    expect(robotsAllows(d, '/news/a')).toBe(true);
    expect(robotsAllows(d, '/private/x')).toBe(false);
    expect(robotsAllows(d, '/news/a?x=1')).toBe(false);
    expect(robotsAllows(d, '/private/ok')).toBe(true);
    expect(robotsAllows(d, '/private/ok/more')).toBe(false);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n'), '/a')).toBe(false);
  });
});

describe('resolvePlayer', () => {
  const roster = [
    { playerId: 1, name: 'G. Jesus' },
    { playerId: 2, name: 'Weverton' },
    { playerId: 3, name: 'M. Ødegaard' },
    { playerId: 4, name: 'Vinícius Júnior' },
    { playerId: 5, name: 'A. Silva' },
    { playerId: 6, name: 'B. Silva' },
  ];
  it('exact', () => expect(resolvePlayer('Weverton', roster)).toEqual({ player: roster[1], match: 'EXACT' }));
  it('surname with a compatible initial', () => expect(resolvePlayer('Gabriel Jesus', roster)).toEqual({ player: roster[0], match: 'FUZZY' }));
  it('accents and special letters', () => expect(resolvePlayer('Martin Odegaard', roster).player?.playerId).toBe(3));
  it('Jr. is Júnior', () => expect(resolvePlayer('Vinicius Jr', roster).match).toBe('EXACT'));
  it('ambiguous surname is never guessed', () => expect(resolvePlayer('Silva', roster)).toEqual({ player: null, match: 'UNRESOLVED' }));
  it('initial decides between two Silvas', () => expect(resolvePlayer('Bernardo Silva', roster).player?.playerId).toBe(6));
  it('unknown', () => expect(resolvePlayer('Someone Else', roster).match).toBe('UNRESOLVED'));
});

describe('verdicts', () => {
  const facts = { alreadyInApi: false, recentStarts: 5, recentLineups: 5, minutesPlayedShare: 0.9, goalShare: 0.1, resolved: true, novel: true };
  it('novelty against API injuries', () => {
    expect(novelty(base, { alreadyInApi: false, coachAlreadyVisible: false })).toBe('NOVEL');
    expect(novelty(base, { alreadyInApi: true, coachAlreadyVisible: false })).toBe('CONFIRMS_API');
    expect(novelty({ ...base, severity: 'RETURNED_EARLY' }, { alreadyInApi: true, coachAlreadyVisible: false })).toBe('CONTRADICTS_API');
  });
  it('impact: regular starter HIGH, fringe LOW, unresolved UNKNOWN', () => {
    expect(impact(base, facts)).toBe('HIGH');
    expect(impact(base, { ...facts, recentStarts: 0, minutesPlayedShare: 0.1 })).toBe('LOW');
    expect(impact(base, { ...facts, resolved: false })).toBe('UNKNOWN');
  });
  const st = (over: Partial<StatusInput>): StatusInput => ({
    signal: base,
    quoteOk: true,
    articleAbout: 'YES',
    published: new Date('2026-11-25T03:00:00Z'),
    basis: 'PAGE_META',
    collected: new Date('2026-11-25T06:20:00Z'),
    cutoff: new Date('2026-11-25T07:00:00Z'),
    since: new Date('2026-11-23T00:00:00Z'),
    tier: 'reputable_media',
    corroboratedByBetterTier: false,
    playerResolved: true,
    ...over,
  });
  it('eligible', () => expect(signalStatus(st({}))).toEqual({ status: 'ELIGIBLE', reasons: [] }));
  it('quote not found or collected after the cut-off: rejected', () => {
    expect(signalStatus(st({ quoteOk: false })).status).toBe('REJECTED');
    expect(signalStatus(st({ collected: new Date('2026-11-25T07:00:01Z') })).reasons).toContain('COLLECTED_AFTER_CUTOFF');
    expect(signalStatus(st({ published: new Date('2026-11-25T06:30:00Z') })).reasons).toContain('PUBLISHED_AFTER_COLLECTION');
  });
  it('news from before the previous match is stale', () => expect(signalStatus(st({ published: new Date('2026-11-22T00:00:00Z') })).reasons).toContain('BEFORE_PREVIOUS_MATCH'));
  it('no timestamp, lone aggregator, rumour, unresolved player: unverified', () => {
    expect(signalStatus(st({ basis: 'NONE', published: null })).status).toBe('UNVERIFIED');
    expect(signalStatus(st({ tier: 'aggregator' })).status).toBe('UNVERIFIED');
    expect(signalStatus(st({ tier: 'aggregator', corroboratedByBetterTier: true })).status).toBe('ELIGIBLE');
    expect(signalStatus(st({ signal: { ...base, attribution: 'UNATTRIBUTED_RUMOUR' } })).status).toBe('UNVERIFIED');
    expect(signalStatus(st({ playerResolved: false })).status).toBe('UNVERIFIED');
  });
  it('feed-only timestamp stays eligible, with a note', () => expect(signalStatus(st({ basis: 'RSS_ONLY' }))).toEqual({ status: 'ELIGIBLE', reasons: ['note:TIMESTAMP_RSS_ONLY'] }));
});
