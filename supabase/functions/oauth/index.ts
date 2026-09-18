import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

const APP_API = "https://wuikfmmwvrzpaoevtskn.supabase.co/functions/v1/app-api";
const ISSUER = "https://reader.antonioskilton.com";
const RESOURCE = `${ISSUER}/api/mcp`;
const TEST_CLIENT = `${ISSUER}/oauth/test-client.json`;
const SCOPES = ["reader:read", "reader:write"];

function routePath(req: Request) {
  const p = new URL(req.url).pathname;
  const marker = "/oauth";
  const i = p.indexOf(marker);
  return i >= 0 ? p.slice(i + marker.length) || "/" : p;
}
function json(data: unknown, status = 200, extra: Record<string,string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra
    }
  });
}
function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer"
    }
  });
}
function esc(v: unknown) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function token(prefix: string, bytes = 32) {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return prefix + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256(v: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
async function pkceS256(verifier: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function normalizeEmail(v: unknown) { return String(v || "").trim().toLowerCase(); }
function validEmail(v: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 320; }
function allowedClientId(v: string) {
  return v === TEST_CLIENT ||
    v === "https://chatgpt.com/oauth/client.json" ||
    /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]+\/client\.json$/.test(v);
}
function parseScopes(raw: string) {
  const xs = [...new Set(String(raw || "").split(/\s+/).filter(Boolean))];
  if (!xs.length) return ["reader:read", "reader:write"];
  if (xs.some(x => !SCOPES.includes(x))) throw new Error("Unsupported OAuth scope.");
  return xs;
}
function fieldsFromUrl(url: URL) {
  return {
    response_type: url.searchParams.get("response_type") || "",
    client_id: url.searchParams.get("client_id") || "",
    redirect_uri: url.searchParams.get("redirect_uri") || "",
    code_challenge: url.searchParams.get("code_challenge") || "",
    code_challenge_method: url.searchParams.get("code_challenge_method") || "",
    state: url.searchParams.get("state") || "",
    scope: url.searchParams.get("scope") || "",
    resource: url.searchParams.get("resource") || ""
  };
}
function hidden(fields: Record<string,string>) {
  return Object.entries(fields).map(([k,v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
}
function page(title: string, inner: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Morning Reader</title>
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#201f1a;background:#f5f1e8}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{width:min(520px,100%);background:#fffdf8;border:1px solid #ded8ca;border-radius:22px;padding:28px;box-shadow:0 18px 50px rgba(40,34,24,.08)}
.brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;font-weight:800;color:#174f3c;margin-bottom:18px}
h1{font-family:Georgia,serif;font-size:32px;line-height:1.05;margin:0 0 12px}p{line-height:1.5;color:#655f55}
label{display:block;font-size:13px;font-weight:750;margin:18px 0 7px}.input{width:100%;padding:13px 14px;border:1px solid #cbc3b3;border-radius:12px;font:inherit;background:white}
.btn{margin-top:18px;width:100%;border:0;border-radius:12px;padding:13px 16px;background:#174f3c;color:white;font:inherit;font-weight:800;cursor:pointer}
.permissions{margin:18px 0;padding:14px 16px;background:#f4efe5;border-radius:12px}.permissions div{margin:6px 0}.muted{font-size:13px;color:#756e63}.error{padding:12px 14px;border-radius:10px;background:#fdebe8;color:#8f2d24;margin:14px 0}
</style></head><body><main class="card"><div class="brand">Morning Reader</div>${inner}</main></body></html>`;
}
async function appApi(path: string, method = "GET", body?: unknown, bearer?: string) {
  const r = await fetch(APP_API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${r.status}` }; }
  if (!r.ok) throw Object.assign(new Error(data?.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}
async function clientMetadata(clientId: string) {
  if (!allowedClientId(clientId)) throw new Error("This OAuth client is not allowed.");
  if (clientId === TEST_CLIENT) {
    return {
      client_id: TEST_CLIENT,
      client_name: "Morning Reader MCP Test Client",
      redirect_uris: [`${ISSUER}/oauth/test-callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web"
    };
  }
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(clientId, { signal: c.signal, redirect: "error", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Client metadata returned HTTP ${r.status}.`);
    const text = (await r.text()).slice(0, 65536);
    const data = JSON.parse(text);
    if (data.client_id !== clientId) throw new Error("Client metadata client_id mismatch.");
    return data;
  } finally { clearTimeout(timer); }
}
async function validateAuthFields(f: Record<string,string>) {
  if (f.response_type !== "code") throw new Error("response_type must be code.");
  if (!f.client_id || !f.redirect_uri) throw new Error("client_id and redirect_uri are required.");
  if (f.code_challenge_method !== "S256") throw new Error("PKCE S256 is required.");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(f.code_challenge)) throw new Error("Invalid PKCE code_challenge.");
  if (f.resource !== RESOURCE) throw new Error("Invalid OAuth resource.");
  const scopes = parseScopes(f.scope);
  const meta = await clientMetadata(f.client_id);
  if (!Array.isArray(meta.redirect_uris) || !meta.redirect_uris.includes(f.redirect_uri)) throw new Error("redirect_uri is not registered by this client.");
  return { scopes, meta };
}
function authFieldsFromForm(form: FormData) {
  const names = ["response_type","client_id","redirect_uri","code_challenge","code_challenge_method","state","scope","resource"];
  return Object.fromEntries(names.map(n => [n, String(form.get(n) || "")])) as Record<string,string>;
}
function consentHtml(f: Record<string,string>, clientName: string, error = "") {
  const scopeList = parseScopes(f.scope);
  return page("Connect ChatGPT", `
    <h1>Connect ${esc(clientName)} to Morning Reader</h1>
    <p>Sign in to your Morning Reader account. You’ll approve the requested access after entering the email code.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <div class="permissions">
      <strong>Requested access</strong>
      ${scopeList.includes("reader:read") ? "<div>✓ View your Kindle editions, sources, previews, and delivery status</div>" : ""}
      ${scopeList.includes("reader:write") ? "<div>✓ Create editions, add sources, and send editions</div>" : ""}
    </div>
    <form method="post" action="${ISSUER}/oauth/request-code">
      ${hidden(f)}
      <label>Email</label><input class="input" type="email" name="email" autocomplete="email" required>
      <button class="btn" type="submit">Email me a sign-in code</button>
    </form>
    <p class="muted">Morning Reader never gives ChatGPT your Kindle email address as an input credential. Access can be revoked by expiring the OAuth connection.</p>
  `);
}
function verifyHtml(f: Record<string,string>, email: string, clientName: string, error = "") {
  const scopeList = parseScopes(f.scope);
  return page("Approve access", `
    <h1>Approve ${esc(clientName)}</h1>
    <p>Enter the 6-digit code sent to <strong>${esc(email)}</strong>.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <div class="permissions">
      ${scopeList.includes("reader:read") ? "<div>✓ Read Morning Reader account data</div>" : ""}
      ${scopeList.includes("reader:write") ? "<div>✓ Make Morning Reader changes and trigger sends</div>" : ""}
    </div>
    <form method="post" action="${ISSUER}/oauth/verify-code">
      ${hidden(f)}
      <input type="hidden" name="email" value="${esc(email)}">
      <label>Sign-in code</label><input class="input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" name="code" required>
      <button class="btn" type="submit">Connect to Morning Reader</button>
    </form>
  `);
}
async function issueTokens(userId: string, clientId: string, scopes: string[], resource: string) {
  const access = token("mr_at_");
  const refresh = token("mr_rt_", 40);
  const accessExpires = new Date(Date.now() + 3600_000).toISOString();
  const refreshExpires = new Date(Date.now() + 30 * 86400_000).toISOString();
  const { error: ae } = await admin.schema("private").from("oauth_access_tokens").insert({
    token_hash: await sha256(access), user_id: userId, client_id: clientId, scopes, resource, expires_at: accessExpires
  });
  if (ae) throw ae;
  const { error: re } = await admin.schema("private").from("oauth_refresh_tokens").insert({
    token_hash: await sha256(refresh), user_id: userId, client_id: clientId, scopes, resource, expires_at: refreshExpires
  });
  if (re) throw re;
  return { access, refresh, accessExpires };
}

Deno.serve(async (req: Request) => {
  const route = routePath(req);
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });

    if (route === "/oauth-protected-resource" && req.method === "GET") {
      return json({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: SCOPES,
        resource_documentation: `${ISSUER}/`,
        resource_policy_uri: `${ISSUER}/privacy`,
        resource_tos_uri: `${ISSUER}/terms`
      });
    }
    if (route === "/oauth-authorization-server" && req.method === "GET") {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: SCOPES,
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true
      });
    }
    if (route === "/test-client.json" && req.method === "GET") {
      return json(await clientMetadata(TEST_CLIENT));
    }
    if (route === "/test-callback" && req.method === "GET") {
      const u = new URL(req.url);
      return html(page("OAuth test callback", `<h1>OAuth callback received</h1><p class="muted">Code: ${esc(u.searchParams.get("code") || "")}</p><p class="muted">State: ${esc(u.searchParams.get("state") || "")}</p><p class="muted">Issuer: ${esc(u.searchParams.get("iss") || "")}</p>`));
    }

    if (route === "/authorize" && req.method === "GET") {
      const f = fieldsFromUrl(new URL(req.url));
      const { meta } = await validateAuthFields(f);
      return html(consentHtml(f, String(meta.client_name || "ChatGPT")));
    }

    if (route === "/request-code" && req.method === "POST") {
      const form = await req.formData();
      const f = authFieldsFromForm(form);
      const { meta } = await validateAuthFields(f);
      const email = normalizeEmail(form.get("email"));
      if (!validEmail(email)) return html(consentHtml(f, String(meta.client_name || "ChatGPT"), "Enter a valid email address."), 400);
      try {
        await appApi("/auth/request-code", "POST", { email });
        return html(verifyHtml(f, email, String(meta.client_name || "ChatGPT")));
      } catch (e: any) {
        return html(consentHtml(f, String(meta.client_name || "ChatGPT"), String(e?.message || e)), Number(e?.status) || 400);
      }
    }

    if (route === "/verify-code" && req.method === "POST") {
      const form = await req.formData();
      const f = authFieldsFromForm(form);
      const { scopes, meta } = await validateAuthFields(f);
      const email = normalizeEmail(form.get("email"));
      const code = String(form.get("code") || "").replace(/\D/g, "");
      if (!validEmail(email) || !/^\d{6}$/.test(code)) return html(verifyHtml(f, email, String(meta.client_name || "ChatGPT"), "Enter the 6-digit code."), 400);
      let verified: any;
      try {
        verified = await appApi("/auth/verify-code", "POST", { email, code });
      } catch (e: any) {
        return html(verifyHtml(f, email, String(meta.client_name || "ChatGPT"), String(e?.message || e)), Number(e?.status) || 401);
      }
      if (verified?.token) await appApi("/auth/logout", "POST", {}, verified.token).catch(() => {});
      const rawCode = token("mr_code_", 32);
      const { error } = await admin.schema("private").from("oauth_authorization_codes").insert({
        code_hash: await sha256(rawCode),
        user_id: verified.user.id,
        client_id: f.client_id,
        redirect_uri: f.redirect_uri,
        code_challenge: f.code_challenge,
        code_challenge_method: "S256",
        scopes,
        resource: f.resource,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString()
      });
      if (error) throw error;
      const redirect = new URL(f.redirect_uri);
      redirect.searchParams.set("code", rawCode);
      if (f.state) redirect.searchParams.set("state", f.state);
      redirect.searchParams.set("iss", ISSUER);
      return new Response(null, { status: 302, headers: { Location: redirect.toString(), "Cache-Control": "no-store" } });
    }

    if (route === "/token" && req.method === "POST") {
      const form = await req.formData();
      const grant = String(form.get("grant_type") || "");
      const clientId = String(form.get("client_id") || "");
      if (!allowedClientId(clientId)) return json({ error: "invalid_client" }, 401);

      if (grant === "authorization_code") {
        const code = String(form.get("code") || "");
        const redirectUri = String(form.get("redirect_uri") || "");
        const verifier = String(form.get("code_verifier") || "");
        const resource = String(form.get("resource") || RESOURCE);
        if (!code || !redirectUri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return json({ error: "invalid_request" }, 400);
        const { data: row } = await admin.schema("private").from("oauth_authorization_codes").select("*")
          .eq("code_hash", await sha256(code)).is("consumed_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
        if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || row.resource !== resource) return json({ error: "invalid_grant" }, 400);
        if (await pkceS256(verifier) !== row.code_challenge) return json({ error: "invalid_grant" }, 400);
        const { data: consumed } = await admin.schema("private").from("oauth_authorization_codes")
          .update({ consumed_at: new Date().toISOString() }).eq("id", row.id).is("consumed_at", null).select("id").maybeSingle();
        if (!consumed) return json({ error: "invalid_grant" }, 400);
        const t = await issueTokens(row.user_id, row.client_id, row.scopes || [], row.resource);
        return json({
          access_token: t.access,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: t.refresh,
          scope: (row.scopes || []).join(" "),
          resource: row.resource
        });
      }

      if (grant === "refresh_token") {
        const raw = String(form.get("refresh_token") || "");
        const resource = String(form.get("resource") || RESOURCE);
        if (!raw) return json({ error: "invalid_request" }, 400);
        const { data: row } = await admin.schema("private").from("oauth_refresh_tokens").select("*")
          .eq("token_hash", await sha256(raw)).is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
        if (!row || row.client_id !== clientId || row.resource !== resource) return json({ error: "invalid_grant" }, 400);
        const requested = String(form.get("scope") || "").trim();
        const scopes = requested ? parseScopes(requested) : (row.scopes || []);
        if (scopes.some((s: string) => !(row.scopes || []).includes(s))) return json({ error: "invalid_scope" }, 400);
        const { data: revoked } = await admin.schema("private").from("oauth_refresh_tokens")
          .update({ revoked_at: new Date().toISOString() }).eq("id", row.id).is("revoked_at", null).select("id").maybeSingle();
        if (!revoked) return json({ error: "invalid_grant" }, 400);
        const t = await issueTokens(row.user_id, row.client_id, scopes, row.resource);
        const { data: replacement } = await admin.schema("private").from("oauth_refresh_tokens").select("id")
          .eq("token_hash", await sha256(t.refresh)).maybeSingle();
        if (replacement) await admin.schema("private").from("oauth_refresh_tokens").update({ replaced_by: replacement.id }).eq("id", row.id);
        return json({
          access_token: t.access,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: t.refresh,
          scope: scopes.join(" "),
          resource: row.resource
        });
      }

      return json({ error: "unsupported_grant_type" }, 400);
    }

    return json({ error: "not_found" }, 404);
  } catch (e: any) {
    console.error(e);
    if (route === "/authorize" && req.method === "GET") return html(page("Connection error", `<h1>Couldn’t start the connection</h1><div class="error">${esc(String(e?.message || e))}</div>`), 400);
    return json({ error: "server_error", error_description: String(e?.message || e).slice(0, 300) }, 500);
  }
});