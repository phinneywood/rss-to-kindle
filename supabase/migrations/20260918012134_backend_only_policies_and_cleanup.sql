create table if not exists private.worker_state (
  name text primary key,
  last_started_at timestamptz not null default 'epoch'::timestamptz
);

insert into private.worker_state(name,last_started_at)
select name,last_started_at from public.worker_state
on conflict(name) do update set last_started_at=excluded.last_started_at;

create or replace function public.claim_worker_run(
  p_name text default 'digest-worker',
  p_min_interval_seconds integer default 240
)
returns boolean
language plpgsql
security definer
set search_path=public,private,pg_catalog
as $$
declare last_at timestamptz;
begin
  insert into private.worker_state(name,last_started_at)
  values(p_name,'epoch'::timestamptz)
  on conflict(name) do nothing;

  select last_started_at into last_at
  from private.worker_state
  where name=p_name
  for update;

  if last_at > now()-make_interval(secs=>p_min_interval_seconds) then
    return false;
  end if;

  update private.worker_state set last_started_at=now() where name=p_name;
  return true;
end;
$$;

revoke all on function public.claim_worker_run(text,integer) from public,anon,authenticated;
grant execute on function public.claim_worker_run(text,integer) to service_role;

drop table public.worker_state;

drop policy if exists backend_only on public.app_users;
create policy backend_only on public.app_users as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.login_codes;
create policy backend_only on public.login_codes as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.sessions;
create policy backend_only on public.sessions as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.user_settings;
create policy backend_only on public.user_settings as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.sections;
create policy backend_only on public.sections as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.feeds;
create policy backend_only on public.feeds as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.digests;
create policy backend_only on public.digests as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.article_deliveries;
create policy backend_only on public.article_deliveries as restrictive for all to anon,authenticated using(false) with check(false);
drop policy if exists backend_only on public.digest_jobs;
create policy backend_only on public.digest_jobs as restrictive for all to anon,authenticated using(false) with check(false);

create or replace function public.cleanup_auth_artifacts()
returns void
language plpgsql
security definer
set search_path=public,pg_catalog
as $$
begin
  delete from public.login_codes where created_at < now()-interval '1 day';
  delete from public.sessions
  where expires_at < now()-interval '7 days'
     or (revoked_at is not null and revoked_at < now()-interval '7 days');
end;
$$;

revoke all on function public.cleanup_auth_artifacts() from public,anon,authenticated;
grant execute on function public.cleanup_auth_artifacts() to service_role;

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname='morning-reader-auth-cleanup'
  loop perform cron.unschedule(j.jobid); end loop;
end $$;

select cron.schedule(
  'morning-reader-auth-cleanup',
  '17 3 * * *',
  $$select public.cleanup_auth_artifacts();$$
);
