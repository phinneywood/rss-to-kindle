# Long Form

Long Form puts readers back in charge of their attention by turning the long-form publications they choose into one calm daily Kindle issue (an EPUB file). Readers manage a flat source list; at issue time an AI editor organizes every eligible subscribed-feed article into dynamic sections, using a fixed **Other** section when no coherent grouping fits. The editor never drops an otherwise eligible RSS article. Readers can also add 1–20 article URLs to the next issue under a reading-list name.

Article pages are reduced to their readable body while preserving headings, lists, links, tables, code, quotations, captions, and supported images. The opening contents page shows Section → Topic → Article title, with each article title linking directly to the article; EPUB 3 and legacy Kindle navigation expose the same hierarchy. Every EPUB also includes reflowable styling, publisher metadata, and a dated cover designed to remain recognizable as a Kindle home-screen thumbnail.

Covers use a 1200×1600 JPEG with both EPUB 3 and legacy cover metadata, without an additional HTML cover page. This packaging was confirmed in Kindle iOS on September 19, 2026. Article anchors that EPUB rejects are repaired with their local links preserved. Existing delivered documents are not updated; the change applies when a new EPUB is built.

## Daily issue and AI editor

The account has one delivery time and time zone. The worker checks every five minutes and queues one due issue per account. Manual sends and scheduled sends share the daily idempotency key, so repeated attempts do not produce a second daily issue. Explicit test sends remain separate.

Recurring source eligibility remains deterministic: enabled source, lookback/freshness, successful extraction, duplicate suppression, prior recurring delivery suppression, and hard safety/resource limits. Every article that survives those rules is passed to the issue organizer and must be placed exactly once in a dynamic section or **Other**.

The editor also has two bounded, non-blocking discovery lanes:
- **Related Discovery** searches beyond subscribed RSS for up to two articles that materially extend themes already present in the organized RSS issue.
- **Open Discovery** searches beyond both RSS and today's themes for up to two strong articles that fit the user's explicit editorial brief. It is skipped when no brief exists.

Discovery failure never blocks the core RSS issue. Already delivered RSS articles are suppressed deterministically, and one-off article selections are consumed by the next issue.

## Source warnings

Dashboard warnings identify each affected recurring source directly. Paused source failures remain visible as historical errors on the source row. Article browsing and System health link errors to the same source controls.

`POST /feeds/:id/check` rechecks one non-archived source owned by the signed-in account. It reuses the normal feed preview and persisted health tracking, returns the updated dashboard, does not resume paused feeds, and never queues a Kindle delivery. Publisher failures remain actionable in the dialog; recovered sources lose their warning.

## Production architecture

```
Web browser ──────────────┐
                         ├─> Long Form app-api ─> Postgres
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
- `supabase/functions/mcp` — Long Form MCP server
- `supabase/functions/oauth` — OAuth authorization server for MCP account linking
- `supabase/migrations` — migration history matching production

## MCP

The MCP exposes a narrow Long Form tool surface rather than generic database or HTTP access:

- `get_profile`
- `list_sources`
- `find_feeds`
- `add_source`
- `preview_sources`
- `get_editorial_brief`
- `update_editorial_brief`
- `send_now`

OAuth scopes:
- `reader:read` — profile, source list, feed discovery, previews, editorial brief
- `reader:write` — source changes, editorial-brief updates, and delivery actions

OAuth metadata is published at:
- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`

The authorization flow reuses Long Form's email-code sign-in, requires PKCE S256, validates client metadata and redirect URIs, binds tokens to the MCP resource, stores only token/code hashes, and rotates refresh tokens.

The MCP derives the Long Form user from the OAuth token. Tool inputs never accept a `user_id`. Calls into the existing application API use short-lived internal delegated sessions so the web UI and MCP reuse the same tenant checks and business rules.

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

The Vercel `long-form` project is connected to this GitHub repository. Pushes to `main` are the production deployment path.

## Verification

CI type-checks the API and worker, parses the browser scripts, and tests extraction, metadata, sanitization, EPUB output, article-title contents completeness, media fallbacks/diagnostics, all-eligible editorial organization, both discovery lanes, network limits, private-address rejection, frozen-manifest delivery fault recovery, and interface regressions. Run `deno test --allow-env --allow-read supabase/tests` and `node --test tests/*.test.mjs` after `npm ci`. HTTP in worker tests is mocked; no emails or production records are created by the suite.

## Delivery reliability and limits

- `delivery_outbox` freezes the complete email and attachment bytes before the first provider request. Retries reuse that payload and idempotency key. A saved provider ID skips sending and only reconciles history. Ambiguous sends stop before the provider's 24-hour idempotency window expires.
- Prepared payloads are backend-only and removed by daily cleanup seven days after terminal jobs finish. Metadata remains for history. Account deletion cascades through jobs to the outbox.
- `sent` means accepted by the email provider, **not** confirmed by Amazon. `partial` means submitted with source or image omissions; `empty` is reserved for successful checks with no new articles. Source failures cannot silently become an empty success.
- Downloads have streaming byte caps and a deadline covering DNS, redirects, headers, and body. Extraction uses a shared 6 MB image budget, 80-second job / 90-second invocation preparation deadline, and a combined 16 MB base64 attachment cap. Very large articles are rejected rather than silently truncated.
- JPEG, PNG and GIF are embedded directly. Lazy image attributes and Kindle-safe `picture` fallbacks are preferred, encoded publisher-origin URLs (including Substack transforms) are recovered before fetching, and WebP-only images are lazily transcoded to PNG with pinned ImageMagick WASM. AVIF and SVG remain non-blocking omissions when no supported fallback exists; diagnostics retain the exact image URL and failure reason.
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
- Login codes expire after ten minutes. Browser sessions expire after 90 days of inactivity; authenticated use renews that window. Explicit sign-out revokes the session. Network and server errors preserve the saved login and offer a retry. Internal MCP sessions retain their fixed two-minute expiry; stale OAuth artifacts are cleaned automatically.
