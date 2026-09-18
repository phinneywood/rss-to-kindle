create or replace function public.mcp_validate_oauth_access_token(
  p_token_hash text,
  p_resource text
)
returns table(
  token_id uuid,
  user_id uuid,
  email text,
  client_id text,
  scopes text[]
)
language sql
security definer
set search_path = private, public, pg_catalog
as $$
  select t.id, t.user_id, u.email, t.client_id, t.scopes
  from private.oauth_access_tokens t
  join public.app_users u on u.id=t.user_id
  where t.token_hash=p_token_hash
    and t.resource=p_resource
    and t.revoked_at is null
    and t.expires_at > now()
  limit 1
$$;

create or replace function public.oauth_store_authorization_code(
  p_code_hash text,
  p_user_id uuid,
  p_client_id text,
  p_redirect_uri text,
  p_code_challenge text,
  p_scopes text[],
  p_resource text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = private, public, pg_catalog
as $$
declare v_id uuid;
begin
  insert into private.oauth_authorization_codes(
    code_hash,user_id,client_id,redirect_uri,code_challenge,code_challenge_method,scopes,resource,expires_at
  ) values (
    p_code_hash,p_user_id,p_client_id,p_redirect_uri,p_code_challenge,'S256',p_scopes,p_resource,p_expires_at
  ) returning id into v_id;
  return v_id;
end
$$;

create or replace function public.oauth_get_authorization_code(
  p_code_hash text,
  p_client_id text,
  p_redirect_uri text,
  p_resource text
)
returns table(
  id uuid,
  user_id uuid,
  code_challenge text,
  scopes text[]
)
language sql
security definer
set search_path = private, public, pg_catalog
as $$
  select c.id,c.user_id,c.code_challenge,c.scopes
  from private.oauth_authorization_codes c
  where c.code_hash=p_code_hash
    and c.client_id=p_client_id
    and c.redirect_uri=p_redirect_uri
    and c.resource=p_resource
    and c.consumed_at is null
    and c.expires_at > now()
  limit 1
$$;

create or replace function public.oauth_consume_authorization_code(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = private, public, pg_catalog
as $$
declare n int;
begin
  update private.oauth_authorization_codes
  set consumed_at=now()
  where id=p_id and consumed_at is null and expires_at>now();
  get diagnostics n = row_count;
  return n=1;
end
$$;

create or replace function public.oauth_issue_tokens(
  p_access_hash text,
  p_refresh_hash text,
  p_user_id uuid,
  p_client_id text,
  p_scopes text[],
  p_resource text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = private, public, pg_catalog
as $$
declare v_refresh_id uuid;
begin
  insert into private.oauth_access_tokens(token_hash,user_id,client_id,scopes,resource,expires_at)
  values(p_access_hash,p_user_id,p_client_id,p_scopes,p_resource,p_access_expires_at);

  insert into private.oauth_refresh_tokens(token_hash,user_id,client_id,scopes,resource,expires_at)
  values(p_refresh_hash,p_user_id,p_client_id,p_scopes,p_resource,p_refresh_expires_at)
  returning id into v_refresh_id;

  return v_refresh_id;
end
$$;

create or replace function public.oauth_get_refresh_token(
  p_token_hash text,
  p_client_id text,
  p_resource text
)
returns table(
  id uuid,
  user_id uuid,
  client_id text,
  scopes text[],
  resource text
)
language sql
security definer
set search_path = private, public, pg_catalog
as $$
  select r.id,r.user_id,r.client_id,r.scopes,r.resource
  from private.oauth_refresh_tokens r
  where r.token_hash=p_token_hash
    and r.client_id=p_client_id
    and r.resource=p_resource
    and r.revoked_at is null
    and r.expires_at>now()
  limit 1
$$;

create or replace function public.oauth_rotate_refresh_token(
  p_old_id uuid,
  p_access_hash text,
  p_refresh_hash text,
  p_user_id uuid,
  p_client_id text,
  p_scopes text[],
  p_resource text,
  p_access_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = private, public, pg_catalog
as $$
declare
  n int;
  v_new_id uuid;
begin
  update private.oauth_refresh_tokens
  set revoked_at=now()
  where id=p_old_id and revoked_at is null and expires_at>now();
  get diagnostics n = row_count;
  if n<>1 then return false; end if;

  insert into private.oauth_access_tokens(token_hash,user_id,client_id,scopes,resource,expires_at)
  values(p_access_hash,p_user_id,p_client_id,p_scopes,p_resource,p_access_expires_at);

  insert into private.oauth_refresh_tokens(token_hash,user_id,client_id,scopes,resource,expires_at)
  values(p_refresh_hash,p_user_id,p_client_id,p_scopes,p_resource,p_refresh_expires_at)
  returning id into v_new_id;

  update private.oauth_refresh_tokens set replaced_by=v_new_id where id=p_old_id;
  return true;
end
$$;

revoke all on function public.mcp_validate_oauth_access_token(text,text) from public, anon, authenticated;
revoke all on function public.oauth_store_authorization_code(text,uuid,text,text,text,text[],text,timestamptz) from public, anon, authenticated;
revoke all on function public.oauth_get_authorization_code(text,text,text,text) from public, anon, authenticated;
revoke all on function public.oauth_consume_authorization_code(uuid) from public, anon, authenticated;
revoke all on function public.oauth_issue_tokens(text,text,uuid,text,text[],text,timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.oauth_get_refresh_token(text,text,text) from public, anon, authenticated;
revoke all on function public.oauth_rotate_refresh_token(uuid,text,text,uuid,text,text[],text,timestamptz,timestamptz) from public, anon, authenticated;

grant execute on function public.mcp_validate_oauth_access_token(text,text) to service_role;
grant execute on function public.oauth_store_authorization_code(text,uuid,text,text,text,text[],text,timestamptz) to service_role;
grant execute on function public.oauth_get_authorization_code(text,text,text,text) to service_role;
grant execute on function public.oauth_consume_authorization_code(uuid) to service_role;
grant execute on function public.oauth_issue_tokens(text,text,uuid,text,text[],text,timestamptz,timestamptz) to service_role;
grant execute on function public.oauth_get_refresh_token(text,text,text) to service_role;
grant execute on function public.oauth_rotate_refresh_token(uuid,text,text,uuid,text,text[],text,timestamptz,timestamptz) to service_role;
