# Morning Reader

Morning Reader turns websites, RSS, and Atom feeds into grouped Kindle editions (EPUB files). Editions can be delivered on a schedule or assembled once from 1–20 article URLs under a user-supplied name.

Article pages are reduced to their readable body while preserving headings, lists, links, tables, code, quotations, captions, and supported images. Every EPUB includes reflowable styling, EPUB 3 and legacy Kindle navigation, publisher metadata, and a dated cover designed to remain recognizable as a Kindle home-screen thumbnail.

## Production architecture

```
Web browser ──────────────┐
                         ├─> Morning Reader app-api ─> Postgres
ChatGPT / MCP client      │                         │
        │                 │                         │
        └─ OAuth ─> MCP ──┘                         │
                                                   │
pg_cron / manual trigger ──────────────> worker ───┘
                                          │
                                          ├─> RSS/Atom + public article pages
                                          └─> EPUB -> Resend -> Amazon Send to Kindle
```

Production:
- Web app: `https://reader.antonioskilton.com`
- MCP endpoint: `https://reader.antonioskilton.com/api/mcp`
- Supabase project: `wuikfmmwvrzpaoevtskn`

## Repository layout

- `index.html` — current beta web UI
- `privacy.html`, `terms.html` — beta legal pages
- `vercel.json` — Vercel static configuration and custom-domain rewrites
- `supabase/functions/app-api` — browser application API and magic-code authentication
- `supabase/functions/worker` — scheduling, feed fetching, EPUB generation, and delivery
- `supabase/functions/_shared` — safe article extraction, image embedding, cover rendering, and EPUB packaging
- `supabase/functions/mcp` — Morning Reader MCP server
- `supabase/functions/oauth` — OAuth authorization server for MCP account linking
- `supabase/migrations` — migration history matching production

## MCP

The MCP exposes a narrow Morning Reader tool surface rather than generic database or HTTP access:

- `get_profile`
- `list_editions`
- `create_edition`
- `find_feeds`
- `add_source`
- `preview_edition`
- `send_now`

OAuth scopes:
- `reader:read` — profile, editions, feed discovery, previews
- `reader:write` — edition/source changes and delivery actions

OAuth metadata is published at:
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`

The authorization flow reuses Morning Reader's email-code sign-in, requires PKCE S256, validates client metadata and redirect URIs, binds tokens to the MCP resource, stores only token/code hashes, and rotates refresh tokens.

The MCP derives the Morning Reader user from the OAuth token. Tool inputs never accept a `user_id`. Calls into the existing application API use short-lived internal delegated sessions so the web UI and MCP reuse the same tenant checks and business rules.

## Secrets

Do not commit secrets. `RESEND_API_KEY` is stored as a Supabase Edge Function secret. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed functions.

The worker's cron secret is generated inside Postgres, stored in Supabase Vault, hashed in a private schema, and sent only in internal worker requests. OAuth access tokens, refresh tokens, and authorization codes are also stored only as hashes in the private schema.

## Deploy

```bash
supabase link --project-ref wuikfmmwvrzpaoevtskn
supabase db push
supabase functions deploy app-api --no-verify-jwt
supabase functions deploy worker --no-verify-jwt
supabase functions deploy mcp --no-verify-jwt
supabase functions deploy oauth --no-verify-jwt
```

The worker uses custom `x-worker-secret` authentication. The MCP and OAuth functions implement their own OAuth/token validation, so Supabase JWT verification is intentionally disabled for those endpoints.

The Vercel `morning-reader` project is connected to this GitHub repository. Pushes to `main` are the production deployment path.

## Verification

CI type-checks every Edge Function, parses the browser scripts, and exercises extraction, metadata, sanitization, image packaging, navigation, and EPUB output. Release candidates are also checked with the W3C EPUBCheck validator before Kindle acceptance testing.

## Security

- User-facing tables use RLS with no direct client policies; access goes through server-side functions.
- MCP tokens are opaque, hashed at rest, resource-bound, scoped, expiring, and refresh-token rotated.
- MCP tenant identity comes from validated OAuth state, never model-supplied identifiers.
- OAuth authorization uses PKCE S256 and registered redirect-URI validation.
- Private OAuth tables are accessed only through service-role-restricted security-definer functions.
- Feed fetching blocks localhost/private/reserved IPs and validates redirects.
- Article HTML is sanitized before EPUB generation.
- Recurring deliveries suppress previously delivered articles; one-time editions intentionally allow explicit resends. Every email remains idempotent by job at the provider boundary.
- Worker calls require a Vault-backed secret.
- Login codes expire after ten minutes; browser sessions expire after thirty days; stale OAuth artifacts are cleaned automatically.
