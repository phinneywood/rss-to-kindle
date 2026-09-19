create table public.pending_issue_articles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  section_name text not null default 'Saved articles' check (char_length(section_name) between 1 and 80),
  url text not null,
  created_at timestamptz not null default now(),
  unique(user_id,url)
);
create index pending_issue_articles_user_idx on public.pending_issue_articles(user_id,created_at);
alter table public.pending_issue_articles enable row level security;
revoke all on public.pending_issue_articles from public,anon,authenticated;
grant all on public.pending_issue_articles to service_role;
