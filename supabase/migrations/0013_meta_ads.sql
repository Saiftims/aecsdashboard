-- Every ad in the Meta account with its creative (copy + image) and its
-- daily performance, for the Marketing page (owner, 2026-10-14: "a full image
-- of the ad we are running and its performance ... list them for all the ads
-- and allow me to filter and rank"). Synced by /api/cron/meta-spend every 6h
-- with the ads_read token.
--
-- image_url / thumbnail_url are Meta CDN links that EXPIRE (the `oe=` query
-- param is a unix expiry, typically a week or two out). They are refreshed on
-- every sync and the page never links to them directly: /api/marketing/image
-- proxies them and re-reads the creative from Meta if the link has lapsed.

create table if not exists meta_ads (
  ad_id            text primary key,
  name             text,
  status           text,              -- what the advertiser set: ACTIVE / PAUSED / ARCHIVED
  effective_status text,              -- what Meta is doing: ACTIVE / PAUSED / DISAPPROVED / ADSET_PAUSED / ...
  adset_id         text,
  adset_name       text,
  campaign_id      text,
  campaign_name    text,
  objective        text,
  creative_id      text,
  title            text,
  body             text,
  cta              text,
  link             text,
  form_id          text,
  image_url        text,
  thumbnail_url    text,
  image_hash       text,
  video_id         text,
  post_id          text,              -- effective_object_story_id, for a permalink
  issues           jsonb,             -- issues_info from Meta (why disapproved)
  created_time     timestamptz,
  updated_time     timestamptz,
  synced_at        timestamptz not null default now()
);

create table if not exists meta_ad_insights_daily (
  ad_id        text not null,
  day          date not null,
  spend_cents  integer not null default 0,
  impressions  integer not null default 0,
  reach        integer not null default 0,
  clicks       integer not null default 0,
  link_clicks  integer not null default 0,
  leads        integer not null default 0,   -- onsite_conversion.lead_grouped
  synced_at    timestamptz not null default now(),
  primary key (ad_id, day)
);

create index if not exists meta_ad_insights_daily_day_idx on meta_ad_insights_daily (day);
