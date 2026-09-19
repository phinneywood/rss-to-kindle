-- Null means a fixed lifetime (including MCP's two-minute delegated sessions).
alter table public.sessions add column idle_timeout_seconds integer
  check (idle_timeout_seconds > 0);

-- Only upgrade still-valid browser sessions. Never revive expired/revoked tokens.
-- Before this migration browsers received 30 days; MCP received two minutes.
update public.sessions
set idle_timeout_seconds = 7776000,
    expires_at = greatest(expires_at, last_seen_at + interval '90 days')
where revoked_at is null and expires_at > now()
  and expires_at - created_at >= interval '29 days';

create function public.authenticate_app_session(p_token_hash text)
returns table(session_id uuid, user_id uuid, email text)
language sql volatile security invoker
set search_path = ''
as $$
  with valid_session as (
    update public.sessions s
    set last_seen_at = greatest(s.last_seen_at, statement_timestamp()),
        expires_at = case when s.idle_timeout_seconds is null then s.expires_at
          else greatest(s.expires_at,
            statement_timestamp() + make_interval(secs => s.idle_timeout_seconds))
          end
    where s.token_hash = p_token_hash
      and s.revoked_at is null
      and s.expires_at > statement_timestamp()
    returning s.id, s.user_id
  )
  select s.id, s.user_id, u.email::text
  from valid_session s join public.app_users u on u.id = s.user_id;
$$;

revoke all on function public.authenticate_app_session(text) from public, anon, authenticated;
grant execute on function public.authenticate_app_session(text) to service_role;
