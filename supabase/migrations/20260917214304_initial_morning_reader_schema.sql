create extension if not exists citext with schema public;

create table public.app_users (id uuid primary key default gen_random_uuid(),email citext not null unique,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.login_codes (id uuid primary key default gen_random_uuid(),email citext not null,code_hash text not null,expires_at timestamptz not null,attempts integer not null default 0,consumed_at timestamptz,created_at timestamptz not null default now());
create table public.sessions (id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_users(id) on delete cascade,token_hash text not null unique,expires_at timestamptz not null,last_seen_at timestamptz not null default now(),revoked_at timestamptz,created_at timestamptz not null default now());
create table public.user_settings (user_id uuid primary key references public.app_users(id) on delete cascade,kindle_email citext,timezone text not null default 'America/Los_Angeles',delivery_time time not null default '06:00:00',paused boolean not null default false,onboarding_complete boolean not null default false,next_run_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create table public.sections (id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_users(id) on delete cascade,name text not null,position integer not null default 0,enabled boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,name));
create table public.feeds (id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_users(id) on delete cascade,section_id uuid not null references public.sections(id) on delete cascade,name text not null,url text not null,kind text not null default 'standard',enabled boolean not null default true,last_fetch_at timestamptz,last_error text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,url));
create table public.digests (id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_users(id) on delete cascade,section_id uuid references public.sections(id) on delete set null,scheduled_for timestamptz,status text not null default 'building' check(status in('building','sent','empty','failed')),article_count integer not null default 0,provider_email_id text,error text,created_at timestamptz not null default now(),sent_at timestamptz);
create table public.article_deliveries (id uuid primary key default gen_random_uuid(),user_id uuid not null references public.app_users(id) on delete cascade,feed_id uuid references public.feeds(id) on delete set null,section_id uuid references public.sections(id) on delete set null,digest_id uuid references public.digests(id) on delete set null,canonical_url text not null,article_hash text not null,title text not null,published_at timestamptz,delivered_at timestamptz not null default now(),unique(user_id,article_hash));

alter table public.app_users enable row level security;
alter table public.login_codes enable row level security;
alter table public.sessions enable row level security;
alter table public.user_settings enable row level security;
alter table public.sections enable row level security;
alter table public.feeds enable row level security;
alter table public.digests enable row level security;
alter table public.article_deliveries enable row level security;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
create trigger app_users_touch_updated_at before update on public.app_users for each row execute function public.touch_updated_at();
create trigger user_settings_touch_updated_at before update on public.user_settings for each row execute function public.touch_updated_at();
create trigger sections_touch_updated_at before update on public.sections for each row execute function public.touch_updated_at();
create trigger feeds_touch_updated_at before update on public.feeds for each row execute function public.touch_updated_at();

create index login_codes_email_created_idx on public.login_codes(email,created_at desc);
create index sessions_user_idx on public.sessions(user_id);
create index sessions_token_idx on public.sessions(token_hash);
create index sections_user_idx on public.sections(user_id,position);
create index feeds_user_section_idx on public.feeds(user_id,section_id);
create index digests_user_created_idx on public.digests(user_id,created_at desc);
create index article_deliveries_user_idx on public.article_deliveries(user_id,delivered_at desc);
