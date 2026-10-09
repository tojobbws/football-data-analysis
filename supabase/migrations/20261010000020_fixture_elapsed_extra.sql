-- =====================================================================
-- 0020 fixtures.elapsed_extra
-- Stoppage-time minutes from the API (fixture.status.extra), so live pages can show "45+2′"
-- instead of a frozen "45′". Null outside stoppage time. Written by every fixture sync.
-- =====================================================================

alter table fixtures add column if not exists elapsed_extra int;
