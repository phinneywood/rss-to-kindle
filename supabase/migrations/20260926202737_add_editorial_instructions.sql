alter table public.user_settings
  add column if not exists editorial_instructions text not null default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_settings'::regclass
      and conname = 'user_settings_editorial_instructions_length'
  ) then
    alter table public.user_settings
      add constraint user_settings_editorial_instructions_length
      check (char_length(editorial_instructions) <= 3000);
  end if;
end
$$;
