create table if not exists private.oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  user_id uuid not null references public.app_users(id) on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
  scopes text[] not null default '{}',
  resource text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.oauth_access_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references public.app_users(id) on delete cascade,
  client_id text not null,
  scopes text[] not null default '{}',
  resource text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.oauth_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references public.app_users(id) on delete cascade,
  client_id text not null,
  scopes text[] not null default '{}',
  resource text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid references private.oauth_refresh_tokens(id),
  created_at timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_expiry_idx
  on private.oauth_authorization_codes(expires_at);
create index if not exists oauth_access_tokens_user_idx
  on private.oauth_access_tokens(user_id, expires_at);
create index if not exists oauth_access_tokens_expiry_idx
  on private.oauth_access_tokens(expires_at);
create index if not exists oauth_refresh_tokens_user_idx
  on private.oauth_refresh_tokens(user_id, expires_at);
create index if not exists oauth_refresh_tokens_expiry_idx
  on private.oauth_refresh_tokens(expires_at);

revoke all on private.oauth_authorization_codes from public, anon, authenticated;
revoke all on private.oauth_access_tokens from public, anon, authenticated;
revoke all on private.oauth_refresh_tokens from public, anon, authenticated;
grant all on private.oauth_authorization_codes to service_role;
grant all on private.oauth_access_tokens to service_role;
grant all on private.oauth_refresh_tokens to service_role;

create or replace function public.cleanup_auth_artifacts()
returns void
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $$
begin
  delete from public.login_codes
  where created_at < now()-interval '1 day';

  delete from public.sessions
  where expires_at < now()-interval '7 days'
     or (revoked_at is not null and revoked_at < now()-interval '7 days');

  delete from private.oauth_authorization_codes
  where expires_at < now()-interval '1 day'
     or (consumed_at is not null and consumed_at < now()-interval '1 day');

  delete from private.oauth_access_tokens
  where expires_at < now()-interval '7 days'
     or (revoked_at is not null and revoked_at < now()-interval '7 days');

  delete from private.oauth_refresh_tokens
  where expires_at < now()-interval '7 days'
     or (revoked_at is not null and revoked_at < now()-interval '7 days');
end;
$$;

revoke all on function public.cleanup_auth_artifacts() from public, anon, authenticated;
grant execute on function public.cleanup_auth_artifacts() to service_role;
