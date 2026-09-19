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

CI type-checks the API and worker, parses the browser scripts, and tests extraction, metadata, sanitization, EPUB output, network limits, private-address rejection, delivery fault recovery, and interface regressions. Run `deno test --allow-env --allow-read supabase/tests` and `node --test tests/*.test.mjs` after `npm ci`. HTTP in worker tests is mocked; no emails or production records are created by the suite.

## Delivery reliability and limits

- `delivery_outbox` freezes the complete email and attachment bytes before the first provider request. Retries reuse that payload and idempotency key. A saved provider ID skips sending and only reconciles history. Ambiguous sends stop before the provider's 24-hour idempotency window expires.
- Prepared payloads are backend-only and removed by daily cleanup seven days after terminal jobs finish. Metadata remains for history. Account deletion cascades through jobs to the outbox.
- `sent` means accepted by the email provider, **not** confirmed by Amazon. `partial` means submitted with source or image omissions; `empty` is reserved for successful checks with no new articles. Source failures cannot silently become an empty success.
- Downloads have streaming byte caps and a deadline covering DNS, redirects, headers, and body. Extraction uses a shared 6 MB image budget, 80-second job / 90-second invocation preparation deadline, and a combined 16 MB base64 attachment cap. Very large articles are rejected rather than silently truncated.
- JPEG, PNG and GIF are embedded. Lazy image attributes and JPEG/PNG `picture` fallbacks are supported. Unsupported WebP, AVIF and SVG are deliberately omitted with a warning and original-article link; there is no image transcoder in the edge worker.
- The preview is a headline browser, not an EPUB rendering. One-time review shows text excerpts and extraction warnings; images are checked during sending, and publisher content can change between review and preparation.

## Security

- User-facing tables use RLS with no direct client policies; access goes through server-side functions.
- MCP tokens are opaque, hashed at rest, resource-bound, scoped, expiring, and refresh-token rotated.
- MCP tenant identity comes from validated OAuth state, never model-supplied identifiers.
- OAuth authorization uses PKCE S256 and registered redirect-URI validation.
- Private OAuth tables are accessed only through service-role-restricted security-definer functions.
- Feed fetching blocks localhost/private/reserved IPs (including IPv4-mapped IPv6) and validates every redirect. DNS preflight is defense-in-depth, not connection-level DNS pinning; preventing malicious DNS rebinding completely still requires an egress proxy or runtime-enforced network policy.
- Article HTML is sanitized before EPUB generation.
- Recurring deliveries suppress previously delivered articles; one-time editions intentionally allow explicit resends. Every email remains idempotent by job at the provider boundary.
- Worker calls require a Vault-backed secret.
- Login codes expire after ten minutes; browser sessions expire after thirty days; stale OAuth artifacts are cleaned automatically.
