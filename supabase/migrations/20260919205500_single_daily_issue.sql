-- Collapse per-edition delivery into one account-wide daily issue.
-- Existing section weekday choices are retained as section inclusion days.
-- Existing account delivery_time becomes the single issue delivery time.

create or replace function public.next_delivery_at(
  p_timezone text,p_time time,p_from timestamptz default now()
) returns timestamptz language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare local_day date; candidate timestamptz;
begin
  if p_time is null then return null; end if;
  local_day := (p_from at time zone p_timezone)::date;
  candidate := (local_day+p_time) at time zone p_timezone;
  if candidate <= p_from then candidate := ((local_day+1)+p_time) at time zone p_timezone; end if;
  return candidate;
end $$;

update public.user_settings u
set next_run_at=case when not u.paused and u.onboarding_complete and u.kindle_email is not null
  then public.next_delivery_at(u.timezone,u.delivery_time) end;

create or replace function public.refresh_account_daily_schedule()
returns trigger language plpgsql security invoker set search_path=public,pg_catalog as $$
begin
  if new.timezone is distinct from old.timezone or new.delivery_time is distinct from old.delivery_time
    or new.paused is distinct from old.paused or new.onboarding_complete is distinct from old.onboarding_complete
    or new.kindle_email is distinct from old.kindle_email then
    new.next_run_at := case when not new.paused and new.onboarding_complete and new.kindle_email is not null
      then public.next_delivery_at(new.timezone,new.delivery_time) end;
  end if;
  return new;
end $$;
drop trigger if exists user_settings_refresh_daily_schedule on public.user_settings;
create trigger user_settings_refresh_daily_schedule before update on public.user_settings
  for each row execute function public.refresh_account_daily_schedule();

-- The old trigger must no longer treat section schedule fields as independent deliveries.
drop trigger if exists user_settings_refresh_edition_schedules on public.user_settings;
drop trigger if exists sections_refresh_schedule on public.sections;
update public.sections set next_run_at=null;

create or replace function public.queue_due_daily_issues(p_now timestamptz default now())
returns integer language plpgsql security invoker set search_path=public,pg_catalog as $$
declare account record; queued integer:=0; local_date date;
begin
  for account in
    select u.* from public.user_settings u
    where not u.paused and u.onboarding_complete and u.kindle_email is not null and u.next_run_at<=p_now
    order by u.next_run_at,u.user_id limit 50 for update skip locked
  loop
    local_date := (account.next_run_at at time zone account.timezone)::date;
    insert into public.digest_jobs(user_id,reason,scheduled_for,lookback_hours,idempotency_key,run_after)
    values(account.user_id,'scheduled',account.next_run_at,48,
      format('daily-issue:%s:%s',account.user_id,local_date),p_now)
    on conflict(idempotency_key) do nothing;
    if found then queued:=queued+1; end if;
    update public.user_settings set next_run_at=public.next_delivery_at(
      account.timezone,account.delivery_time,p_now) where user_id=account.user_id;
  end loop;
  return queued;
end $$;

revoke all on function public.next_delivery_at(text,time,timestamptz) from public,anon,authenticated;
revoke all on function public.queue_due_daily_issues(timestamptz) from public,anon,authenticated;
revoke all on function public.refresh_account_daily_schedule() from public,anon,authenticated;
grant execute on function public.next_delivery_at(text,time,timestamptz) to service_role;
grant execute on function public.queue_due_daily_issues(timestamptz) to service_role;
grant execute on function public.refresh_account_daily_schedule() to service_role;
