alter table public.sections add column if not exists archived_at timestamptz;
alter table public.feeds add column if not exists archived_at timestamptz;
create table public.digest_jobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.app_users(id) on delete cascade,
 reason text not null default 'scheduled' check(reason in('scheduled','manual','test')),
 status text not null default 'queued' check(status in('queued','running','sent','empty','partial','failed')),
 lookback_hours integer not null default 168 check(lookback_hours between 1 and 720),
 idempotency_key text not null unique,
 run_after timestamptz not null default now(),
 started_at timestamptz,finished_at timestamptz,attempts integer not null default 0,
 result jsonb not null default '{}'::jsonb,error text,created_at timestamptz not null default now()
);
alter table public.digest_jobs enable row level security;
create index digest_jobs_status_run_after_idx on public.digest_jobs(status,run_after);
create index digest_jobs_user_created_idx on public.digest_jobs(user_id,created_at desc);
create or replace function public.next_delivery_at(p_timezone text,p_time time,p_from timestamptz default now())
returns timestamptz language plpgsql stable set search_path=public,pg_catalog as $$
declare local_day date;candidate timestamptz;
begin
 begin perform now() at time zone p_timezone; exception when others then p_timezone:='UTC'; end;
 local_day:=(p_from at time zone p_timezone)::date;
 candidate:=(local_day+p_time) at time zone p_timezone;
 if candidate<=p_from then candidate:=((local_day+1)+p_time) at time zone p_timezone; end if;
 return candidate;
end$$;
