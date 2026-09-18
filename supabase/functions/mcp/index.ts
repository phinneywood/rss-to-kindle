const APP_API = "https://wuikfmmwvrzpaoevtskn.supabase.co/functions/v1/app-api";
const PROTOCOL_VERSION = "2025-06-18";

type RpcId = string | number | null;

const TOOLS = [
  {
    name: "list_editions",
    description: "List this user's Morning Reader Kindle editions and the sources grouped into each edition.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "create_edition",
    description: "Create a new Morning Reader Kindle edition. Each edition is delivered as its own EPUB.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 80, description: "Edition name shown on the EPUB and cover." } },
      required: ["name"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "add_source",
    description: "Add a website or RSS/Atom source to a specific Morning Reader Kindle edition.",
    inputSchema: {
      type: "object",
      properties: {
        edition_id: { type: "string", minLength: 1, description: "Morning Reader edition ID." },
        url: { type: "string", minLength: 1, description: "Website URL or direct RSS/Atom feed URL." },
        name: { type: "string", maxLength: 120, description: "Optional display name. Morning Reader will infer one if omitted." }
      },
      required: ["edition_id", "url"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "preview_edition",
    description: "Preview recent articles from the active sources in one Morning Reader edition without sending anything.",
    inputSchema: {
      type: "object",
      properties: { edition_id: { type: "string", minLength: 1, description: "Morning Reader edition ID." } },
      required: ["edition_id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "send_now",
    description: "Queue the user's current Morning Reader editions for immediate delivery to the configured Send-to-Kindle address.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
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

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    structuredContent: typeof data === "object" && data !== null ? data : { value: data },
    ...(isError ? { isError: true } : {})
  };
}

function bearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

async function api(path: string, token: string, method = "GET", body?: unknown) {
  const r = await fetch(APP_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${r.status}` }; }
  if (!r.ok) {
    const e: any = new Error(data?.error || `Morning Reader API returned HTTP ${r.status}`);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

async function requireUser(token: string) {
  if (!token) return null;
  try { return await api("/me", token); } catch { return null; }
}

function editionView(section: any) {
  return {
    id: section.id,
    name: section.name,
    enabled: section.enabled,
    sources: (section.feeds || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      url: f.url,
      enabled: f.enabled,
      last_error: f.last_error || null
    }))
  };
}

async function callTool(name: string, args: any, token: string, me: any) {
  switch (name) {
    case "list_editions":
      return toolResult({ editions: (me.sections || []).map(editionView) });

    case "create_edition": {
      const nameArg = String(args?.name || "").trim();
      if (!nameArg || nameArg.length > 80) return toolResult({ error: "Edition name must be 1–80 characters." }, true);
      const after = await api("/sections", token, "POST", { name: nameArg });
      const edition = [...(after.sections || [])].reverse().find((s: any) => s.name === nameArg);
      return toolResult({ edition: edition ? editionView(edition) : { name: nameArg } });
    }

    case "find_feeds": {
      const url = String(args?.url || "").trim();
      if (!url) return toolResult({ error: "url is required." }, true);
      const found = await api("/discover", token, "POST", { url });
      return toolResult(found);
    }

    case "add_source": {
      const editionId = String(args?.edition_id || "");
      const url = String(args?.url || "").trim();
      if (!editionId || !url) return toolResult({ error: "edition_id and url are required." }, true);
      const after = await api("/feeds", token, "POST", {
        section_id: editionId,
        url,
        ...(args?.name ? { name: String(args.name).trim() } : {})
      });
      const edition = (after.sections || []).find((s: any) => s.id === editionId);
      return toolResult({ edition: edition ? editionView(edition) : null });
    }

    case "preview_edition": {
      const editionId = String(args?.edition_id || "");
      const edition = (me.sections || []).find((s: any) => s.id === editionId);
      if (!edition) return toolResult({ error: "Edition not found." }, true);
      const feedIds = new Set((edition.feeds || []).filter((f: any) => f.enabled).map((f: any) => f.id));
      const result = await api("/preview", token, "POST", {});
      const matching = (result.feeds || []).filter((f: any) => feedIds.has(f.feed_id));
      const items = matching.flatMap((f: any) => f.items || [])
        .sort((a: any, b: any) => (b.published_at ? +new Date(b.published_at) : 0) - (a.published_at ? +new Date(a.published_at) : 0));
      return toolResult({ edition: { id: edition.id, name: edition.name }, items, feeds: matching });
    }

    case "send_now": {
      const queued = await api("/send-now", token, "POST", {});
      return toolResult(queued);
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, accept", "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  }
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json", "Allow": "POST" } });

  let msg: any;
  try { msg = await req.json(); } catch { return rpcError(null, -32700, "Parse error", undefined, 400); }
  const id: RpcId = msg?.id ?? null;
  if (msg?.jsonrpc !== "2.0" || typeof msg?.method !== "string") return rpcError(id, -32600, "Invalid Request", undefined, 400);

  const token = bearer(req);
  const me = await requireUser(token);
  if (!me) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" }
    });
  }

  try {
    if (msg.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "morning-reader", version: "0.1.0" },
        instructions: "Manage Morning Reader Kindle editions and RSS/Atom sources. Each edition becomes a separate EPUB."
      });
    }
    if (msg.method === "ping") return rpcResult(id, {});
    if (msg.method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (msg.method === "tools/call") {
      const name = String(msg.params?.name || "");
      const args = msg.params?.arguments || {};
      try {
        return rpcResult(id, await callTool(name, args, token, me));
      } catch (e: any) {
        if (e?.rpcCode) return rpcError(id, e.rpcCode, e.message);
        if (e?.status === 401) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
        }
        return rpcResult(id, toolResult({ error: String(e?.message || e) }, true));
      }
    }
    if (msg.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    return rpcError(id, -32601, "Method not found");
  } catch (e: any) {
    console.error(e);
    return rpcError(id, -32603, "Internal error", { message: String(e?.message || e).slice(0, 400) });
  }
});
