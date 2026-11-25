# Home-page banners, gambling advertisers accepted behind a kill switch

Status: **Accepted, 2026-11-25** (owner). Spec: `.scratch/banners/spec.md`.

## Context

- The site needs direct ad revenue. `PRODUCT.md` planned revenue "deliberately not dependent on gambling advertisers",
  and the brand rule is "Information, not gambling".
- The owner decided (2026-11-25) to sell banner space on the home page and to accept gambling advertisers, after the
  risks were put to them: Thai law on advertising online gambling (domain block by MDES), Meta/Google policies on the
  FB/IG pages and AdSense, and the record pages reading as a tip sheet next to a betting banner.

## Decision

1. Three banner slots on the home page (every view: today, other dates, `?live=1`): above the day's matches, after the
   2nd league group and after the 5th; a between-league slot shows only when a league follows it. One banner per slot,
   chosen by priority among the banners in their run period; the same banner never shows twice on one page.
2. Each banner has a wide picture (1340×200, ≥ 640 px screens) and a phone picture (1080×360), alt text, an https
   destination, slots, priority, start/end, on/off. It is labelled โฆษณา, opens in a new tab with
   `rel="sponsored noopener"`, and clicks are counted through `/go/<id>` (known bots excluded).
3. A banner is flagged **gambling** or not. One switch in /admin hides every gambling banner at once, without a deploy.
4. Pictures live in a new public R2 bucket on a site subdomain, uploaded from /admin with the existing presign code.

## Consequences

- `PRODUCT.md` no longer promises independence from gambling advertisers. The editorial rules stay: analysis text,
  films and the Game Compass still never use betting words, and banners never sit inside a match card or the pick.
- If the domain is blocked or a platform objects, the kill switch removes the gambling banners in one action; the
  analysis pages are unchanged by them.
- Clicks are the only measure at first; impressions are not counted.
