create index if not exists feeds_section_idx on public.feeds(section_id);
create index if not exists digests_section_idx on public.digests(section_id);
create index if not exists article_deliveries_feed_idx on public.article_deliveries(feed_id);
create index if not exists article_deliveries_section_idx on public.article_deliveries(section_id);
create index if not exists article_deliveries_digest_idx on public.article_deliveries(digest_id);
