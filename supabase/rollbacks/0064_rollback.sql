-- Rolls back 0064. The TikTok sign-in is lost; run scripts/tiktok-setup.ts again after re-applying.
drop table if exists oauth_tokens;
