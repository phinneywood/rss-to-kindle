create index if not exists oauth_authorization_codes_user_idx
  on private.oauth_authorization_codes(user_id);

create index if not exists oauth_refresh_tokens_replaced_by_idx
  on private.oauth_refresh_tokens(replaced_by)
  where replaced_by is not null;
