alter table public.feeds
  add column if not exists consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  add column if not exists last_success_at timestamptz;

create index if not exists feeds_user_failure_health_idx
  on public.feeds (user_id, consecutive_failures desc)
  where archived_at is null and enabled = true and consecutive_failures > 0;
