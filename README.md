# Morning Reader

Morning Reader turns RSS and Atom feeds into sectioned EPUB files and delivers them to a user's Kindle on a schedule.

## Production architecture

```
Vercel static web app
        |
        v
Supabase app-api Edge Function -> Postgres
                                      ^
                                      |
pg_cron every 5 min -> worker Edge Function
                         |      |
                         |      +-> Resend -> Amazon Send to Kindle
                         +-> RSS/Atom + public article pages -> EPUB
```

Production Supabase project: `wuikfmmwvrzpaoevtskn`.

## Repository layout

- `index.html` — current beta web UI
- `privacy.html`, `terms.html` — beta legal pages
- `vercel.json` — Vercel static configuration
- `supabase/functions/app-api` — application API and authentication
- `supabase/functions/worker` — scheduling, feed fetching, EPUB generation and delivery
- `supabase/migrations` — migration history matching production

## Secrets

Do not commit secrets. `RESEND_API_KEY` is stored as a Supabase Edge Function secret. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed functions.

The worker's cron secret is generated inside Postgres, stored in Supabase Vault, hashed in a private schema, and sent only in the internal scheduled request.

## Deploy

```bash
supabase link --project-ref wuikfmmwvrzpaoevtskn
supabase db push
supabase functions deploy app-api --no-verify-jwt
supabase functions deploy worker --no-verify-jwt
```

The worker uses custom `x-worker-secret` authentication even though Supabase JWT verification is disabled.

Connect this repository to the existing Vercel `morning-reader` project and deploy `main` to production.

## Security

- User-facing tables use RLS with no direct client policies; access goes through server-side functions.
- Feed fetching blocks localhost/private/reserved IPs and validates every redirect.
- Article HTML is sanitized before EPUB generation.
- Delivery is idempotent by user/article hash and by Resend job key.
- Worker calls require a Vault-backed secret.
- Login codes expire after ten minutes; sessions expire after thirty days.

The UI is intentionally still rough. Infrastructure is being stabilized before the design/UX polish pass.
