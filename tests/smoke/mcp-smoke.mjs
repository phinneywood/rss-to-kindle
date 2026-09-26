import assert from "node:assert/strict";

const MCP_URL = process.env.MORNING_READER_MCP_URL || "https://reader.antonioskilton.com/api/mcp";
const APP_API_URL = process.env.MORNING_READER_APP_API_URL || "https://wuikfmmwvrzpaoevtskn.supabase.co/functions/v1/app-api";
const TOKEN_A = process.env.MORNING_READER_TOKEN_A;
const TOKEN_B = process.env.MORNING_READER_TOKEN_B;
const FOREIGN_EDITION_ID = process.env.MORNING_READER_FOREIGN_EDITION_ID;
if (!TOKEN_A || !TOKEN_B || !FOREIGN_EDITION_ID) {
  throw new Error("Set MORNING_READER_TOKEN_A, MORNING_READER_TOKEN_B, and MORNING_READER_FOREIGN_EDITION_ID.");
}

let seq = 0;
const results = [];
async function rpc(token, method, params = {}) {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params })
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}
async function tool(token, name, args = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  return r;
}
async function getDashboard(token) {
  const r = await fetch(APP_API_URL + "/me", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  return await r.json();
}
async function smoke(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("PASS", name); }
  catch (e) { results.push({ name, ok: false, error: String(e?.message || e) }); console.error("FAIL", name, e); }
}

await smoke("rejects missing auth", async () => {
  const r = await rpc("", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(r.status, 401);
});
await smoke("rejects invalid auth", async () => {
  const r = await rpc("not-a-real-token", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(r.status, 401);
});
await smoke("initializes MCP", async () => {
  const r = await rpc(TOKEN_A, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.serverInfo.name, "long-form");
  assert.equal(r.body.result.protocolVersion, "2025-06-18");
});
await smoke("lists the six V1 tools", async () => {
  const r = await rpc(TOKEN_A, "tools/list");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result.tools.map(t => t.name).sort(), ["add_source","create_edition","find_feeds","list_editions","preview_edition","send_now"].sort());
});
await smoke("tenant A cannot see tenant B edition", async () => {
  const a = await tool(TOKEN_A, "list_editions");
  const b = await tool(TOKEN_B, "list_editions");
  const aText = a.body.result.content[0].text;
  const bText = b.body.result.content[0].text;
  assert.ok(!aText.includes("Smoke B Private"));
  assert.ok(bText.includes("Smoke B Private"));
});
let editionId = "";
await smoke("creates an edition", async () => {
  const name = "Smoke " + Date.now();
  const r = await tool(TOKEN_A, "create_edition", { name });
  assert.equal(r.body.result.isError, undefined);
  const data = JSON.parse(r.body.result.content[0].text);
  assert.equal(data.edition.name, name);
  editionId = data.edition.id;
  assert.ok(editionId);
});
await smoke("validates bad edition names", async () => {
  const r = await tool(TOKEN_A, "create_edition", { name: "" });
  assert.equal(r.body.result.isError, true);
});
await smoke("blocks cross-tenant edition writes", async () => {
  const r = await tool(TOKEN_A, "add_source", { edition_id: FOREIGN_EDITION_ID, url: "https://hnrss.org/frontpage" });
  assert.equal(r.body.result.isError, true);
});
await smoke("discovers a direct feed", async () => {
  const r = await tool(TOKEN_A, "find_feeds", { url: "https://hnrss.org/frontpage" });
  assert.equal(r.body.result.isError, undefined);
  const data = JSON.parse(r.body.result.content[0].text);
  assert.ok(Array.isArray(data.feeds) && data.feeds.length > 0);
});
await smoke("adds a source to the new edition", async () => {
  assert.ok(editionId);
  const r = await tool(TOKEN_A, "add_source", { edition_id: editionId, url: "https://hnrss.org/frontpage", name: "Hacker News Smoke" });
  assert.equal(r.body.result.isError, undefined);
  const data = JSON.parse(r.body.result.content[0].text);
  assert.ok(data.edition.sources.some(s => s.name === "Hacker News Smoke"));
});
await smoke("previews only the requested edition", async () => {
  assert.ok(editionId);
  const r = await tool(TOKEN_A, "preview_edition", { edition_id: editionId });
  assert.equal(r.body.result.isError, undefined);
  const data = JSON.parse(r.body.result.content[0].text);
  assert.equal(data.edition.id, editionId);
  assert.ok(data.items.length > 0);
  assert.ok(data.items.every(x => x.source === "Hacker News Smoke"));
});
await smoke("rejects preview of another tenant's edition", async () => {
  const r = await tool(TOKEN_A, "preview_edition", { edition_id: FOREIGN_EDITION_ID });
  assert.equal(r.body.result.isError, true);
});
let sendJobId = "";
await smoke("queues send_now", async () => {
  const r = await tool(TOKEN_A, "send_now");
  assert.equal(r.body.result.isError, undefined);
  const data = JSON.parse(r.body.result.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(data.worker_triggered, true);
  assert.ok(data.job?.id);
  sendJobId = data.job.id;
});
await smoke("completes the real delivery pipeline", async () => {
  assert.ok(sendJobId);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const dashboard = await getDashboard(TOKEN_A);
    const job = (dashboard.jobs || []).find(j => j.id === sendJobId);
    if (job?.status === "sent") {
      assert.ok((job.result?.articles || 0) > 0);
      assert.ok((job.result?.sections || 0) > 0);
      return;
    }
    if (job?.status === "failed") throw new Error(job.error || "Delivery job failed");
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error("Delivery did not reach sent within 60 seconds");
});

const failed = results.filter(x => !x.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length) process.exit(1);
