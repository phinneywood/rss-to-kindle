import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

const APP_API = "https://wuikfmmwvrzpaoevtskn.supabase.co/functions/v1/app-api";
const RESOURCE = "https://reader.antonioskilton.com/api/mcp";
const RESOURCE_METADATA = "https://reader.antonioskilton.com/.well-known/oauth-protected-resource";
const PROTOCOL_VERSION = "2025-06-18";

type RpcId = string | number | null;
type AuthInfo = { userId: string; email: string; clientId: string; scopes: string[]; tokenId: string };

const READ_SECURITY = [{ type: "oauth2", scopes: ["reader:read"] }];
const WRITE_SECURITY = [{ type: "oauth2", scopes: ["reader:read", "reader:write"] }];

const PROFILE_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, pattern: "\\S", description: "Opaque stable Long Form profile identifier." },
    email: { type: "string", description: "Long Form account email for display." },
    nickname: { type: "string", description: "Useful account label." }
  },
  required: ["id"],
  additionalProperties: false
};

const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
    enabled: { type: "boolean" },
    last_error: { type: ["string","null"] }
  },
  required: ["id","name","url","enabled","last_error"],
  additionalProperties: false
};
const ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    url: { type: "string" },
    published_at: { type: ["string","null"] },
    source: { type: "string" }
  },
  required: ["title","url","published_at","source"],
  additionalProperties: true
};
const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    editorial_brief: {
      type: "string",
      maxLength: 3000,
      description: "Explicit reader interests and editorial preferences. This guides organization and Open Discovery; it never filters eligible RSS articles."
    }
  },
  required: ["editorial_brief"],
  additionalProperties: false
};

const TOOLS: any[] = [
  {
    name: "get_profile",
    description: "Return the Long Form profile represented by the authenticated connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: PROFILE_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: READ_SECURITY,
    _meta: { "openai/profile": true, securitySchemes: READ_SECURITY }
  },
  {
    name: "list_sources",
    description: "List the user's recurring RSS/Atom sources. Long Form organizes eligible articles dynamically at issue time rather than assigning sources to preset categories.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { sources: { type: "array", items: SOURCE_SCHEMA } }, required: ["sources"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: READ_SECURITY,
    _meta: { securitySchemes: READ_SECURITY }
  },
  {
    name: "find_feeds",
    description: "Find RSS or Atom feeds for a website or validate a direct feed URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", minLength: 1, description: "A website URL or direct RSS/Atom feed URL." } },
      required: ["url"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        feeds: { type: "array", items: { type: "object", properties: { url:{type:"string"}, title:{type:"string"}, method:{type:"string"} }, required:["url","title","method"], additionalProperties:true } },
        powered_by: { type: "string" }
      },
      required: ["feeds"],
      additionalProperties: true
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    securitySchemes: READ_SECURITY,
    _meta: { securitySchemes: READ_SECURITY }
  },
  {
    name: "add_source",
    description: "Add a recurring website or RSS/Atom source. No category or section is required.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, description: "Website URL or direct RSS/Atom feed URL." },
        name: { type: "string", maxLength: 120, description: "Optional display name. Long Form will infer one if omitted." }
      },
      required: ["url"],
      additionalProperties: false
    },
    outputSchema: { type: "object", properties: { source: SOURCE_SCHEMA }, required: ["source"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    securitySchemes: WRITE_SECURITY,
    _meta: { securitySchemes: WRITE_SECURITY }
  },
  {
    name: "preview_sources",
    description: "Browse recent articles across all active recurring sources without sending anything or applying delivery-history suppression.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: ARTICLE_SCHEMA },
        feeds: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      required: ["items","feeds"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    securitySchemes: READ_SECURITY,
    _meta: { securitySchemes: READ_SECURITY }
  },
  {
    name: "get_editorial_brief",
    description: "Return the explicit Long Form editorial brief used for organization and Open Discovery. It is never used to omit eligible RSS articles.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: BRIEF_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: READ_SECURITY,
    _meta: { securitySchemes: READ_SECURITY }
  },
  {
    name: "update_editorial_brief",
    description: "Replace the explicit Long Form editorial brief. This affects organization and Open Discovery, not RSS article eligibility.",
    inputSchema: BRIEF_SCHEMA,
    outputSchema: BRIEF_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: WRITE_SECURITY,
    _meta: { securitySchemes: WRITE_SECURITY }
  },
  {
    name: "send_now",
    description: "Queue the user's current Long Form issue for immediate delivery to the configured Send-to-Kindle address.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    securitySchemes: WRITE_SECURITY,
    _meta: { securitySchemes: WRITE_SECURITY }
  }
];

function rpcResult(id: RpcId, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function rpcError(id: RpcId, code: number, message: string, data?: unknown, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
function toolResult(data: unknown, isError = false, meta?: Record<string,unknown>) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    structuredContent: typeof data === "object" && data !== null ? data : { value: data },
    ...(meta ? { _meta: meta } : {}),
    ...(isError ? { isError: true } : {})
  };
}
function bearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}
function randomToken() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return "mr_delegate_" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256(v: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
async function authenticate(raw: string): Promise<AuthInfo | null> {
  if (!raw) return null;
  const { data, error } = await admin.rpc("mcp_validate_oauth_access_token", {
    p_token_hash: await sha256(raw),
    p_resource: RESOURCE
  });
  if (error || !Array.isArray(data) || !data.length) return null;
  const access:any=data[0];
  return {
    userId: access.user_id,
    email: access.email,
    clientId: access.client_id,
    scopes: access.scopes || [],
    tokenId: access.token_id
  };
}
function hasScopes(auth: AuthInfo, required: string[]) {
  return required.every(s => auth.scopes.includes(s));
}
function authChallenge(required: string[], kind: "invalid_token" | "insufficient_scope" = "invalid_token") {
  const scope = required.join(" ");
  const description = kind === "invalid_token" ? "Connect Long Form to continue." : "Reconnect Long Form with the requested permissions.";
  return `Bearer resource_metadata="${RESOURCE_METADATA}", scope="${scope}", error="${kind}", error_description="${description}"`;
}
function authToolError(required: string[], kind: "invalid_token" | "insufficient_scope" = "invalid_token") {
  return toolResult(
    { error: kind === "invalid_token" ? "Authentication required." : "Additional Long Form permission is required." },
    true,
    { "mcp/www_authenticate": [authChallenge(required, kind)] }
  );
}
async function apiAsUser(userId: string, path: string, method = "GET", body?: unknown) {
  const raw = randomToken();
  const hash = await sha256(raw);
  const { data: session, error: se } = await admin.from("sessions").insert({
    user_id: userId,
    token_hash: hash,
    expires_at: new Date(Date.now() + 2 * 60_000).toISOString()
  }).select("id").single();
  if (se) throw se;
  try {
    const r = await fetch(APP_API + path, {
      method,
      headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${r.status}` }; }
    if (!r.ok) throw Object.assign(new Error(data?.error || `Long Form API returned HTTP ${r.status}`), { status: r.status, data });
    return data;
  } finally {
    await admin.from("sessions").delete().eq("id", session.id);
  }
}
function sourceView(source: any) {
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    enabled: source.enabled,
    last_error: source.last_error || null
  };
}
async function dashboard(userId: string) {
  return await apiAsUser(userId, "/me");
}
function sourcesFrom(me: any) {
  if (Array.isArray(me?.sources)) return me.sources;
  return (me?.sections || []).flatMap((section: any) => section.feeds || []);
}
function requiredScopes(toolName: string) {
  const tool = TOOLS.find(t => t.name === toolName);
  return (tool?.securitySchemes?.find((s: any) => s.type === "oauth2")?.scopes || []) as string[];
}
async function callTool(name: string, args: any, auth: AuthInfo) {
  switch (name) {
    case "get_profile": {
      const profile = { id: auth.userId, email: auth.email, nickname: "Long Form" };
      return {
        content: [{ type: "text", text: JSON.stringify(profile) }],
        structuredContent: profile,
        isError: false
      };
    }
    case "list_sources": {
      const me = await dashboard(auth.userId);
      return toolResult({ sources: sourcesFrom(me).map(sourceView) });
    }
    case "find_feeds": {
      const url = String(args?.url || "").trim();
      if (!url) return toolResult({ error: "url is required." }, true);
      return toolResult(await apiAsUser(auth.userId, "/discover", "POST", { url }));
    }
    case "add_source": {
      const url = String(args?.url || "").trim();
      if (!url) return toolResult({ error: "url is required." }, true);
      const before = await dashboard(auth.userId);
      const previous = new Set(sourcesFrom(before).map((source: any) => source.id));
      const after = await apiAsUser(auth.userId, "/feeds", "POST", {
        url,
        ...(args?.name ? { name: String(args.name).trim() } : {})
      });
      const sources = sourcesFrom(after);
      const source = sources.find((item: any) => !previous.has(item.id)) || sources.at(-1);
      if (!source) return toolResult({ error: "Source was added but could not be read back." }, true);
      return toolResult({ source: sourceView(source) });
    }
    case "preview_sources":
      return toolResult(await apiAsUser(auth.userId, "/preview", "POST", {}));
    case "get_editorial_brief": {
      const me = await dashboard(auth.userId);
      return toolResult({ editorial_brief: String(me?.settings?.editorial_brief || "") });
    }
    case "update_editorial_brief": {
      const editorialBrief = String(args?.editorial_brief || "").trim();
      if (editorialBrief.length > 3000) return toolResult({ error: "Editorial brief must be 3,000 characters or fewer." }, true);
      const after = await apiAsUser(auth.userId, "/settings", "PATCH", { editorial_brief: editorialBrief });
      return toolResult({ editorial_brief: String(after?.settings?.editorial_brief || "") });
    }
    case "send_now":
      return toolResult(await apiAsUser(auth.userId, "/send-now", "POST", {}));
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    } });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST", "Cache-Control": "no-store" }
    });
  }

  let msg: any;
  try { msg = await req.json(); } catch { return rpcError(null, -32700, "Parse error", undefined, 400); }
  const id: RpcId = msg?.id ?? null;
  if (msg?.jsonrpc !== "2.0" || typeof msg?.method !== "string") return rpcError(id, -32600, "Invalid Request", undefined, 400);

  try {
    if (msg.method === "initialize") {
      const requested = String(msg.params?.protocolVersion || PROTOCOL_VERSION);
      const protocolVersion = ["2025-06-18", "2025-03-26"].includes(requested) ? requested : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "long-form", version: "0.2.0" },
        instructions: "Manage Long Form Kindle editions and RSS/Atom sources. Each edition becomes a separate EPUB delivered to the user's Kindle."
      });
    }
    if (msg.method === "ping") return rpcResult(id, {});
    if (msg.method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (msg.method.startsWith("notifications/")) return new Response(null, { status: 202 });

    if (msg.method === "tools/call") {
      const name = String(msg.params?.name || "");
      const args = msg.params?.arguments || {};
      const required = requiredScopes(name);
      const auth = await authenticate(bearer(req));
      if (!auth) return rpcResult(id, authToolError(required.length ? required : ["reader:read"]));
      if (!hasScopes(auth, required)) return rpcResult(id, authToolError(required, "insufficient_scope"));
      try {
        return rpcResult(id, await callTool(name, args, auth));
      } catch (e: any) {
        if (e?.rpcCode) return rpcError(id, e.rpcCode, e.message);
        return rpcResult(id, toolResult({ error: String(e?.message || e) }, true));
      }
    }

    return rpcError(id, -32601, "Method not found");
  } catch (e: any) {
    console.error(e);
    return rpcError(id, -32603, "Internal error", { message: String(e?.message || e).slice(0, 400) });
  }
});
