# TikTok from /admin/social, as a draft in the app's inbox

Status: **Accepted, 2026-11-26** (owner chose inbox upload over Direct Post).

## Context

- 2026-11-11 TikTok was dropped from `/admin/social` (FB + IG only). The same day TikTok removed the 8 Nov recap
  film for its handicap-line wording; films have said picks in football words since (`fanPick`). On 2026-11-26 the
  owner asked for TikTok again as a fourth channel.
- The TikTok Content Posting API has two modes. **Direct Post** (`video.publish`) puts the film on the profile, but
  every post from an app TikTok has not audited is locked to private (`SELF_ONLY`), and the form must follow TikTok's
  posting UX rules (creator info, privacy picked by hand with no default, comment/duet/stitch switches, commercial
  content disclosure). **Upload** (`video.upload`) sends the film to the creator's inbox as a draft; the creator
  finishes it in the app.
- The upload API takes no caption. It allows at most 5 shares to the inbox in any 24 hours.
- TikTok returns a new refresh token on every refresh and the old one stops working (access token 2 h, refresh
  token 180 days), so the token cannot sit in a fixed Worker secret the way `YT_REFRESH_TOKEN` does.
- TikTok fetches by URL only from a verified domain; our films sit in a private R2 bucket behind presigned links.

## Decision

1. `TIKTOK` joins the channels of `/admin/social` in **upload mode**: the film lands in the TikTok app's inbox and
   the owner pastes the caption (a copy button on the result), picks the cover and, if wanted, a TikTok sound, then
   posts in the app. The 0057 check constraint already allowed `TIKTOK`.
2. The Worker streams the film from R2 to TikTok's `upload_url` (FILE_UPLOAD): one chunk up to 64 MB, above that
   32 MB chunks (always ≥ 2; one 64 MB chunk for a 64–128 MB film is refused, 2026-11-27) with the remainder in the last; each chunk is a ranged GET from R2 piped into a
   fixed-length PUT. It then polls `/v2/post/publish/status/fetch/`; `SEND_TO_USER_INBOX` (or `PUBLISH_COMPLETE`)
   ends the row at status **DRAFT** with a note, since nothing public exists to link to.
3. Checks before upload: 3 s – 10 min, each side 360–4096 px, caption checked like the others (≤ 2,200, banned
   words) because the owner pastes it; at most 5 TikTok rows (not FAILED) in the last 24 hours.
4. Tokens live in the new table `oauth_tokens` (migration 0064, one row per provider, role ADMIN only for read and
   write). The current access token is kept with its expiry so polls reuse it; a refresh replaces the row only while
   it still holds the old refresh token, and a refresh that fails because a parallel request rotated first uses the
   stored result. The Worker holds only `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
5. `scripts/tiktok-setup.ts` signs the account in once (Desktop Login Kit, loopback redirect
   `http://127.0.0.1:3455/callback/`, PKCE with a hex SHA-256 challenge as TikTok requires, scopes
   `user.info.basic,video.upload`), writes the row to `oauth_tokens` and, with `--apply`, the two secrets.
6. `/privacy` and `/terms` name TikTok and the Content Posting API.

## Consequences

- Nothing reaches the TikTok profile without the owner's tap in the app, so a film TikTok might read as gambling
  can still be stopped on the phone. The owner can add a TikTok sound, which the API cannot.
- Before TikTok approves the app the owner works in the Sandbox (the channel's account as a target user, Sandbox
  keys); production needs App review with a screen recording of `/admin/social`.
- If the app goes unused for 180 days the refresh token dies; `/admin/social` shows the date and the setup script
  signs in again.
- Direct Post stays possible later (scope `video.publish` + the UX rules + TikTok's audit) if the inbox step proves
  to be the bottleneck.
