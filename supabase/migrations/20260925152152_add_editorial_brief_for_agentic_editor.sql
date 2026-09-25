alter table public.user_settings
  add column if not exists editorial_brief text not null default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_settings'::regclass
      and conname = 'user_settings_editorial_brief_length'
  ) then
    alter table public.user_settings
      add constraint user_settings_editorial_brief_length
      check (char_length(editorial_brief) <= 3000);
  end if;
end
$$;

with explicit_interests as (
  select user_id,
         string_agg(name, ', ' order by first_position) as names
  from (
    select user_id,
           min(name) as name,
           min(position) as first_position
    from public.sections
    where archived_at is null
      and lower(trim(name)) not in ('reading','sources','other','saved articles','weekend reading')
    group by user_id, lower(trim(name))
  ) distinct_names
  group by user_id
)
update public.user_settings settings
set editorial_brief =
  'Broad interests carried forward from your previous Morning Reader setup: '
  || explicit_interests.names
  || '.'
from explicit_interests
where explicit_interests.user_id = settings.user_id
  and settings.editorial_brief = ''
  and explicit_interests.names is not null
  and explicit_interests.names <> '';
