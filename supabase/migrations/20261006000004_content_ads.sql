-- =====================================================================
-- 0004 CONTENT + SOCIAL + ADVERTISING (skeleton for later phases)
-- =====================================================================

create table if not exists article_categories (
  id    int generated always as identity primary key,
  slug  text not null unique,     -- matches, analysis, data-signal, market-movement, stats, tactical, news, underdog
  name  text not null
);

insert into article_categories (slug, name) values
  ('analysis', 'วิเคราะห์เกม'),
  ('data-signal', 'เข็มทิศเกม'),
  ('market-movement', 'แรงตลาด'),
  ('stats', 'สถิติฟุตบอล'),
  ('tactical', 'แท็กติก'),
  ('news', 'ข่าวฟุตบอล'),
  ('underdog', 'ม้ามืด')
on conflict (slug) do nothing;

create table if not exists articles (
  id                      bigint generated always as identity primary key,
  slug                    text not null unique,
  category_id             int references article_categories(id),
  fixture_id              bigint references fixtures(id),
  analysis_prediction_id  bigint references analysis_predictions(id),
  title                   text not null,
  description             text,
  body_md                 text not null,
  og_image_url            text,
  status                  text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','ARCHIVED')),
  generated_by            text,            -- 'ai:<prompt_version>' or 'human:<name>'
  published_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists social_contents (
  id                      bigint generated always as identity primary key,
  fixture_id              bigint references fixtures(id),
  analysis_prediction_id  bigint references analysis_predictions(id),
  format                  text not null,   -- DATA_SHOCK, MATCH_PREVIEW, UNDERDOG_ALERT, MARKET_MOVEMENT, PLAYER_COMPARISON, AFTER_MATCH
  channel                 text not null check (channel in ('TIKTOK','FACEBOOK','YOUTUBE_SHORTS','YOUTUBE','X','THREADS','LINE')),
  script                  text,
  caption                 text,
  asset_urls              jsonb not null default '[]'::jsonb,
  status                  text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','PUBLISHED','REJECTED')),
  created_at              timestamptz not null default now()
);

create table if not exists social_publications (
  id                 bigint generated always as identity primary key,
  social_content_id  bigint not null references social_contents(id),
  channel            text not null,
  external_id        text,
  url                text,
  published_at       timestamptz not null default now(),
  metrics            jsonb,
  metrics_synced_at  timestamptz
);

-- ---------- Ads ----------
create table if not exists advertisers (
  id            bigint generated always as identity primary key,
  name          text not null,
  category      text,          -- guard: avoid depending on gambling advertisers
  contact_email text,
  created_at    timestamptz not null default now()
);

create table if not exists campaigns (
  id             bigint generated always as identity primary key,
  advertiser_id  bigint not null references advertisers(id),
  name           text not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','PAUSED','ENDED')),
  created_at     timestamptz not null default now()
);

create table if not exists placements (
  code    text primary key,
  width   int not null,
  height  int not null,
  device  text not null default 'ALL' check (device in ('ALL','DESKTOP','MOBILE'))
);

insert into placements (code, width, height, device) values
  ('HEADER_970x90', 970, 90, 'DESKTOP'),
  ('HOME_TOP_970x250', 970, 250, 'DESKTOP'),
  ('HOME_SIDEBAR_300x250', 300, 250, 'DESKTOP'),
  ('ARTICLE_TOP_728x90', 728, 90, 'DESKTOP'),
  ('ARTICLE_MIDDLE_728x90', 728, 90, 'DESKTOP'),
  ('ARTICLE_SIDEBAR_300x600', 300, 600, 'DESKTOP'),
  ('MATCH_TOP_728x90', 728, 90, 'DESKTOP'),
  ('MATCH_SIDEBAR_300x250', 300, 250, 'DESKTOP'),
  ('MOBILE_TOP_320x100', 320, 100, 'MOBILE'),
  ('MOBILE_MIDDLE_320x100', 320, 100, 'MOBILE'),
  ('FOOTER_970x90', 970, 90, 'DESKTOP')
on conflict (code) do nothing;

create table if not exists banners (
  id              bigint generated always as identity primary key,
  campaign_id     bigint not null references campaigns(id),
  placement_code  text   not null references placements(code),
  image_url       text   not null,
  target_url      text   not null,
  alt_text        text,
  weight          int    not null default 1,
  is_active       boolean not null default true
);

create table if not exists impressions (
  id           bigint generated always as identity primary key,
  banner_id    bigint not null references banners(id),
  page_path    text,
  occurred_at  timestamptz not null default now()
);
create index if not exists impressions_banner_idx on impressions (banner_id, occurred_at);

create table if not exists clicks (
  id           bigint generated always as identity primary key,
  banner_id    bigint not null references banners(id),
  page_path    text,
  occurred_at  timestamptz not null default now()
);
create index if not exists clicks_banner_idx on clicks (banner_id, occurred_at);
