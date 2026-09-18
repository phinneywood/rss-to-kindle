alter table public.app_users
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

create index if not exists app_users_auth_user_idx
  on public.app_users (auth_user_id)
  where auth_user_id is not null;
