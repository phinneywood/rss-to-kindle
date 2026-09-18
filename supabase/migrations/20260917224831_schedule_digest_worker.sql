create extension if not exists pg_cron;
create extension if not exists pg_net;
alter table public.digests add column if not exists job_id uuid references public.digest_jobs(id) on delete set null;
do $$begin if not exists(select 1 from pg_constraint where conname='digests_job_section_key') then alter table public.digests add constraint digests_job_section_key unique(job_id,section_id);end if;end$$;
create index if not exists digests_job_idx on public.digests(job_id);
create table if not exists public.worker_state(name text primary key,last_started_at timestamptz not null default 'epoch'::timestamptz);
alter table public.worker_state enable row level security;
create or replace function public.claim_worker_run(p_name text default 'digest-worker',p_min_interval_seconds integer default 240)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
declare last_at timestamptz;
begin
 insert into public.worker_state(name,last_started_at) values(p_name,'epoch'::timestamptz) on conflict(name) do nothing;
 select last_started_at into last_at from public.worker_state where name=p_name for update;
 if last_at>now()-make_interval(secs=>p_min_interval_seconds) then return false;end if;
 update public.worker_state set last_started_at=now() where name=p_name;return true;
end$$;
revoke all on function public.claim_worker_run(text,integer) from public,anon,authenticated;
do $$declare j record;begin for j in select jobid from cron.job where jobname='morning-reader-worker' loop perform cron.unschedule(j.jobid);end loop;end$$;
select cron.schedule('morning-reader-worker','*/5 * * * *',$cron$
 select net.http_post(url:='https://wuikfmmwvrzpaoevtskn.supabase.co/functions/v1/worker',headers:=jsonb_build_object('Content-Type','application/json'),body:=jsonb_build_object('source','cron'),timeout_milliseconds:=120000);
$cron$);
