-- Weekdays follow PostgreSQL/JavaScript: Sunday = 0, Saturday = 6.
alter table public.sections
  add column delivery_days smallint[] not null default '{0,1,2,3,4,5,6}',
  add column delivery_time time,
  add column next_run_at timestamptz,
  add column schedule_version integer not null default 1,
  add constraint sections_delivery_days_valid check (
    cardinality(delivery_days) between 1 and 7
    and delivery_days <@ array[0,1,2,3,4,5,6]::smallint[]
    and array_position(delivery_days,null) is null
  );
alter table public.digest_jobs
  add column section_id uuid references public.sections(id) on delete set null,
  add column edition_name text,
  add column scheduled_for timestamptz,
  add column schedule_version integer;
create index sections_next_delivery_idx on public.sections(next_run_at)
  where enabled and archived_at is null;
create index digest_jobs_section_idx on public.digest_jobs(section_id);

create function public.next_edition_delivery_at(p_timezone text,p_time time,p_days smallint[],p_from timestamptz default now())
returns timestamptz language plpgsql stable security invoker set search_path=public,pg_catalog as $$
declare local_day date; candidate timestamptz; offset_days integer;
begin
  if p_time is null or p_days is null or cardinality(p_days)=0 then return null; end if;
  local_day := (p_from at time zone p_timezone)::date;
  for offset_days in 0..7 loop
    if extract(dow from local_day+offset_days)::smallint = any(p_days) then
      candidate := ((local_day+offset_days)+p_time) at time zone p_timezone;
      if candidate > p_from then return candidate; end if;
    end if;
  end loop;
  return null;
end $$;

-- Preserve every existing edition's account schedule and next intended send.
update public.sections s set delivery_time=u.delivery_time,
  next_run_at=case when s.enabled and s.archived_at is null and not u.paused
    and u.onboarding_complete and u.kindle_email is not null
    then coalesce(u.next_run_at,public.next_edition_delivery_at(u.timezone,u.delivery_time,s.delivery_days)) end
from public.user_settings u where u.user_id=s.user_id;
update public.sections set delivery_time='06:00' where delivery_time is null;
alter table public.sections alter column delivery_time set not null;

create function public.refresh_edition_schedule()
returns trigger language plpgsql security invoker set search_path=public,pg_catalog as $$
declare settings public.user_settings;
begin
  select * into settings from public.user_settings where user_id=new.user_id;
  if tg_op='INSERT' then
    new.delivery_time := coalesce(new.delivery_time,settings.delivery_time,'06:00'::time);
  elsif new.delivery_days is not distinct from old.delivery_days
    and new.delivery_time is not distinct from old.delivery_time
    and new.enabled is not distinct from old.enabled
    and new.archived_at is not distinct from old.archived_at then
    return new;
  else
    new.schedule_version := old.schedule_version+1;
  end if;
  new.next_run_at := case when new.enabled and new.archived_at is null
    and not settings.paused and settings.onboarding_complete and settings.kindle_email is not null
    then public.next_edition_delivery_at(settings.timezone,new.delivery_time,new.delivery_days) end;
  return new;
end $$;
create trigger sections_refresh_schedule before insert or update on public.sections
  for each row execute function public.refresh_edition_schedule();

create function public.refresh_account_edition_schedules()
returns trigger language plpgsql security invoker set search_path=public,pg_catalog as $$
begin
  if new.timezone is distinct from old.timezone or new.paused is distinct from old.paused
    or new.onboarding_complete is distinct from old.onboarding_complete
    or new.kindle_email is distinct from old.kindle_email then
    update public.sections s set schedule_version=s.schedule_version+1,
      next_run_at=case when s.enabled and s.archived_at is null and not new.paused
        and new.onboarding_complete and new.kindle_email is not null
        then public.next_edition_delivery_at(new.timezone,s.delivery_time,s.delivery_days) end
    where s.user_id=new.user_id;
  end if;
  return new;
end $$;
create trigger user_settings_refresh_edition_schedules after update on public.user_settings
  for each row execute function public.refresh_account_edition_schedules();

-- Insert and advance in one transaction. Concurrent invocations cannot enqueue
-- the same slot, and an outage creates one catch-up rather than a backlog burst.
create function public.queue_due_editions(p_now timestamptz default now())
returns integer language plpgsql security invoker set search_path=public,pg_catalog as $$
declare edition record; queued integer := 0; gap_days integer; lookback integer; local_day date;
begin
  for edition in
    select s.*,u.timezone from public.sections s join public.user_settings u on u.user_id=s.user_id
    where s.enabled and s.archived_at is null and not u.paused and u.onboarding_complete
      and u.kindle_email is not null and s.next_run_at<=p_now
    order by s.next_run_at,s.id limit 50 for update of s skip locked
  loop
    local_day := (edition.next_run_at at time zone edition.timezone)::date;
    lookback := 192;
    for gap_days in 1..7 loop
      if extract(dow from local_day-gap_days)::smallint=any(edition.delivery_days) then
        lookback := greatest(48,(gap_days+1)*24);
        exit;
      end if;
    end loop;
    insert into public.digest_jobs(user_id,reason,section_id,edition_name,schedule_version,
      scheduled_for,lookback_hours,idempotency_key,run_after)
    values(edition.user_id,'scheduled',edition.id,edition.name,edition.schedule_version,
      edition.next_run_at,lookback,
      format('scheduled-edition:%s:%s:%s',edition.id,edition.schedule_version,extract(epoch from edition.next_run_at)),p_now)
    on conflict(idempotency_key) do nothing;
    if found then queued:=queued+1; end if;
    update public.sections set next_run_at=public.next_edition_delivery_at(
      edition.timezone,edition.delivery_time,edition.delivery_days,p_now) where id=edition.id;
  end loop;
  return queued;
end $$;

-- Retire the old account-wide scheduler before deploying the new worker.
-- Legacy clients may still call this function; a null result cannot enqueue mail.
create or replace function public.next_delivery_at(p_timezone text,p_time time,p_from timestamptz default now())
returns timestamptz language sql stable security invoker set search_path=public,pg_catalog as $$ select null::timestamptz $$;
update public.user_settings set next_run_at=null;

revoke all on function public.next_edition_delivery_at(text,time,smallint[],timestamptz) from public,anon,authenticated;
revoke all on function public.queue_due_editions(timestamptz) from public,anon,authenticated;
revoke all on function public.refresh_edition_schedule() from public,anon,authenticated;
revoke all on function public.refresh_account_edition_schedules() from public,anon,authenticated;
grant execute on function public.next_edition_delivery_at(text,time,smallint[],timestamptz) to service_role;
grant execute on function public.queue_due_editions(timestamptz) to service_role;
grant execute on function public.refresh_edition_schedule() to service_role;
grant execute on function public.refresh_account_edition_schedules() to service_role;
