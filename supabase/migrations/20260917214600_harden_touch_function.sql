create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path=public,pg_temp
as $$begin new.updated_at=now();return new;end$$;
