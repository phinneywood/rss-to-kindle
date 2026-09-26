# Long Form MCP

Production MCP endpoint:

`https://reader.antonioskilton.com/api/mcp`

## Tool model

Long Form keeps the model-facing surface intentionally narrow. The MCP does not expose SQL, generic HTTP requests, or arbitrary user IDs.

| Tool | Scope | Effect |
| --- | --- | --- |
| `get_profile` | `reader:read` | Identify the connected Long Form account |
| `list_editions` | `reader:read` | List Kindle editions and their sources |
| `find_feeds` | `reader:read` | Discover/validate RSS or Atom feeds |
| `preview_edition` | `reader:read` | Preview current articles without sending |
| `create_edition` | `reader:read reader:write` | Create a separate Kindle EPUB edition |
| `add_source` | `reader:read reader:write` | Add a website/feed to an edition |
| `send_now` | `reader:read reader:write` | Queue immediate delivery |

## OAuth

The protected resource is the exact MCP URL. The authorization server is the Long Form custom domain.

The flow:
1. Client discovers protected-resource metadata.
2. Client discovers authorization-server metadata.
3. Client presents a CIMD client ID and registered redirect URI.
4. Long Form requires PKCE S256.
5. User signs in with the existing email-code flow and approves requested scopes.
6. The authorization code is exchanged for an opaque access token and rotating refresh token.
7. The MCP hashes the presented token and validates resource, expiry, revocation, scopes, and user identity before tool execution.

## Test coverage completed during implementation

Production-domain smoke tests exercised:
- MCP `initialize`
- `tools/list` and tool schemas/annotations
- OAuth protected-resource and authorization-server metadata
- PKCE/redirect validation on the authorization endpoint
- unauthenticated linking challenge
- read-only token rejection for write tools
- `get_profile`
- `list_editions`
- `create_edition`
- `find_feeds`
- `add_source`
- `preview_edition`
- cross-tenant edition access rejection
- `send_now` through the real backend precondition path

A complete ChatGPT-host OAuth callback/token exchange remains the final host-level smoke test.
