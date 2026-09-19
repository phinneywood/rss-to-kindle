# Morning Reader social sign-in

Morning Reader keeps the existing six-digit email-code flow and adds Google and Apple through Supabase Auth.

## Architecture

1. The browser signs in with Google or Apple using Supabase Auth.
2. Supabase returns a verified Auth session to the browser.
3. The browser sends the Supabase access token to `POST /auth/exchange-supabase`.
4. `app-api` validates that token with `auth.getUser(jwt)`.
5. Morning Reader links the verified identity to `app_users.auth_user_id`, matching an existing account by verified email when appropriate.
6. Morning Reader issues an application session with a rolling 90-day inactivity timeout. Each authenticated request atomically validates and renews the session; expired or revoked sessions cannot renew. Internal MCP delegated sessions retain their fixed two-minute expiry.

Existing active email-code sessions are upgraded to the same inactivity timeout. Temporary network or server failures keep the browser token and show a retry screen; only an explicit unauthorized response clears it. Sign-out revokes the server session before clearing local credentials.

## Supabase configuration

Production site URL:

`https://reader.antonioskilton.com`

Feature-preview redirect URL for testing:

`https://morning-reader-git-feature-supabase-auth-login-phinneywood.vercel.app`

Supabase OAuth callback registered with Google and Apple:

`https://wuikfmmwvrzpaoevtskn.supabase.co/auth/v1/callback`

Add both the production URL and the preview URL to the Supabase Auth redirect allow list before testing OAuth.

## Google

Create a Web OAuth client in Google Auth Platform.

Authorized JavaScript origin:

`https://reader.antonioskilton.com`

Authorized redirect URI:

`https://wuikfmmwvrzpaoevtskn.supabase.co/auth/v1/callback`

Use only the standard identity scopes required by Supabase: OpenID, email, and profile. Add the Google client ID and client secret under Supabase Authentication > Providers > Google.

For preview testing, add the feature-preview origin as an authorized JavaScript origin if Google requires it for the chosen flow.

## Apple

Create a Sign in with Apple Services ID and private key in Apple Developer.

Configure the website domain for Morning Reader and use this return URL:

`https://wuikfmmwvrzpaoevtskn.supabase.co/auth/v1/callback`

Generate Apple's client-secret JWT and add the Services ID/client ID plus client secret under Supabase Authentication > Providers > Apple.

## Database migration

Apply:

`supabase/migrations/20260918190000_add_supabase_auth_link.sql`

This adds the nullable unique `app_users.auth_user_id` reference. It does not change existing account IDs, feeds, editions, delivery settings, or sessions.

## Pre-production test

- Existing six-digit email sign-in still works.
- Google sign-in returns to the preview URL and opens the correct existing account when the verified email matches.
- Apple sign-in returns to the preview URL and opens the correct existing account when the verified email matches.
- A new Google account creates one Morning Reader account.
- A new Apple account creates one Morning Reader account.
- Sign out clears both the Morning Reader session and Supabase browser session.
- Existing users remain signed in through their current Morning Reader sessions.
- Repeated social sign-in does not create duplicate `app_users` rows.
