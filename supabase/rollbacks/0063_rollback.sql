-- Rolls back 0063. Deletes the banners, their clicks and the site settings (export them first if they matter).
-- The 0004 skeleton tables (banners / clicks / impressions) are not recreated: they were empty and unused.
drop function if exists fp_admin_banner_clicks();
drop function if exists fp_banner_click(bigint, boolean);
drop table if exists banner_clicks;
drop table if exists banners cascade;
drop function if exists fp_banner_live(banners);
drop function if exists fp_gambling_banners_hidden();
drop table if exists site_settings;
drop function if exists fp_banners_touch();
