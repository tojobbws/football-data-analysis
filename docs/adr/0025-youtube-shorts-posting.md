# YouTube Shorts from /admin/social, through the YouTube Data API

Status: **Accepted, 2026-11-25** (owner chose "API, full" over a semi-manual copy-and-paste helper).

## Context

- 2026-11-11 the owner dropped YouTube and TikTok from `/admin/social` (FB + IG only) after seeing what each
  needed: OAuth, an audit before public posts, `/privacy` and `/terms` pages. On 2026-11-25 the owner asked for
  YouTube Shorts again and chose the API route knowing the audit wait.
- YouTube cannot fetch a video by URL (Meta can), and an API project YouTube has not audited gets every
  `videos.insert` upload locked **private**, whatever `privacyStatus` asks for.

## Decision

1. `YOUTUBE_SHORTS` joins the channels of `/admin/social` (the 0057 check constraint already allowed it; no
   migration). Same film in R2, same caption (used as the description), plus a YouTube title (≤ 100 characters,
   banned words checked) and a visibility choice (public / unlisted / private).
2. The Worker streams the film from the private R2 bucket into a resumable upload session (one PUT, fixed length,
   never held in memory), then polls `videos.list part=status` until `processed`. The post links to
   `youtube.com/shorts/<id>`. If YouTube gives a different privacy than asked (not audited yet), the post records
   a note in the history.
3. Limits checked before upload: vertical or square, ≤ 180 s, description ≤ 5,000 UTF-8 bytes, no `<` `>`, ≤ 15
   hashtags. No custom cover: Shorts covers cannot be set through the API.
4. Auth: an OAuth client (Desktop app) in a Google Cloud project, consent screen **In production** (a Testing
   app's refresh token dies after 7 days). `scripts/youtube-setup.ts` signs in the channel owner once and stores
   `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` (scopes `youtube.upload`, `youtube.readonly`). Each channel
   switches on by itself: FB/IG need `META_*`, YouTube needs `YT_*`, all need `R2_*`.
5. New public pages `/privacy` and `/terms` (footer + sitemap), written from what the code actually collects, with
   the YouTube API Services statements the audit asks for.

## Consequences

- Until the YouTube API Services audit passes, Shorts posted from here are private; the owner submits the audit
  form with the site, `/privacy`, `/terms` and a short screen recording of `/admin/social`.
- Upload quota is the default 10,000 units/day per project; an upload is the costly call, enough for our few
  films a day.
- One finish request carries the whole upload; a film that dies mid-stream fails the post (nothing on the
  channel) and can be posted again.
- `CONTACT_EMAIL` in `src/lib/brand.ts` is empty until the owner names an address; the pages then show it.
