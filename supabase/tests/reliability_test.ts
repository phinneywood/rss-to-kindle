import { assertPublic, fetchPublic, isPublicAddress, readLimited } from "../functions/_shared/network.ts";
import { extractionBudget, extractArticle, sanitizeArticleHtml } from "../functions/_shared/article.ts";
import { checkAttachmentBudget, dispatchPrepared, DeliveryNeedsReview, type Outbox, type PreparedDelivery } from "../functions/_shared/delivery.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }
async function rejects(fn: () => unknown, contains?: string) { try { await fn(); } catch (e) { if (contains) assert(String(e).includes(contains), String(e)); return e; } throw new Error("Expected rejection"); }

Deno.test("rejects private, mapped, reserved and non-http destinations", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1"]) {
    assert(!isPublicAddress(ip), ip);
    await rejects(() => assertPublic(new URL(`http://${ip.includes(":") ? `[${ip}]` : ip}/`)));
  }
  for (const url of ["file:///tmp/local", "https://user:pass@8.8.8.8/", "http://localhost/", "http://test.local/"]) await rejects(() => assertPublic(new URL(url)));
  assert(isPublicAddress("8.8.8.8"));assert(isPublicAddress("2606:4700:4700::1111"));
});

Deno.test("limits streamed bodies and cancels oversized responses", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(12)); }, cancel() { canceled = true; } }));
  await rejects(() => readLimited(response, 10), "too large");assert(canceled);
});

Deno.test("deadline includes the response body, not just headers", async () => {
  const original = globalThis.fetch;let canceled = false;
  globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream({ cancel() { canceled = true; } })))) as typeof fetch;
  try { await rejects(() => fetchPublic("https://8.8.8.8/", { accept: "text/html", maxBytes: 100, timeoutMs: 10 })); assert(canceled); }
  finally { globalThis.fetch = original; }
});

Deno.test("validates redirect targets before a second network request", async () => {
  const original = globalThis.fetch;let calls = 0;
  globalThis.fetch = (() => { calls++;return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://[::ffff:127.0.0.1]/" } })); }) as typeof fetch;
  try { await rejects(() => fetchPublic("https://8.8.8.8/", { accept: "*/*", maxBytes: 100 })); assert(calls === 1); }
  finally { globalThis.fetch = original; }
});

Deno.test("repairs lazy placeholders and selects a Kindle-compatible picture fallback", () => {
  const lazy = sanitizeArticleHtml('<img src="data:image/gif;base64,abc" width="1" data-src="/photo.jpg" alt="Photo">', "https://example.com/article");
  assert(lazy.includes('src="https://example.com/photo.jpg"'));
  const picture = sanitizeArticleHtml('<picture><source type="image/jpeg" srcset="/small.jpg 400w, /large.jpg 1000w"><img src="/photo.avif"></picture>', "https://example.com");
  assert(picture.includes("large.jpg"));
});

Deno.test("shares image budget before downloads and reports omitted media", async () => {
  const original = globalThis.fetch;let calls = 0;
  globalThis.fetch = (() => { calls++;return Promise.resolve(new Response(new Uint8Array([137,80,78,71,13,10,26,10,1,2]))); }) as typeof fetch;
  const budget = { ...extractionBudget(), imageBytes: 10 };
  const input = { url: "https://8.8.8.8/story", title: "Example", feedHtml: '<p>'+"Substantial feed text. ".repeat(30)+'</p><img src="https://8.8.8.8/image.png" alt="Photo">', feedKind: "full" as const, budget };
  try { const first = await extractArticle(input), second = await extractArticle(input); assert(first.assets.length === 1);assert(second.assets.length === 0);assert(second.warnings.length > 0);assert(calls === 1);assert(budget.imageBytes === 0); }
  finally { globalThis.fetch = original; }
});

function fixture() {
  let outbox: Outbox | null = null, builds = 0, calls = 0, failRecord = true;
  const requests: string[] = [];
  const payload: PreparedDelivery = { email: { from: "sender@example.com", to: ["reader@example.com"], subject: "Edition", text: "Attached", attachments: [{ content: "frozen-epub" }] }, groups: [], feedCount: 1, issues: [] };
  const deps = {
    load: async () => outbox,
    prepare: async () => { builds++;return structuredClone(payload); },
    freeze: async (payload: PreparedDelivery) => outbox = { payload, first_send_at: null, provider_email_id: null },
    markAttempt: async (at: string) => { outbox!.first_send_at = at; },
    send: async (email: PreparedDelivery["email"]) => { calls++;requests.push(JSON.stringify(email));return { id: "provider-1" }; },
    record: async (id: string) => { if (failRecord) { failRecord = false;throw new Error("database unavailable after accepted email"); } outbox!.provider_email_id = id; },
  };
  return { deps, payload, requests, get builds() { return builds; }, get calls() { return calls; }, get outbox() { return outbox!; } };
}

Deno.test("retry reuses byte-identical payload after provider success and database failure", async () => {
  const f = fixture();await rejects(() => dispatchPrepared(f.deps), "database unavailable");
  f.payload.email.subject = "Changed publisher or settings";
  const result = await dispatchPrepared(f.deps);
  assert(result.providerId === "provider-1");assert(f.builds === 1);assert(f.requests[0] === f.requests[1]);
  await dispatchPrepared(f.deps);assert(f.calls === 2, "Persisted provider ID must skip sending during reconciliation");
});

Deno.test("ambiguous delivery stops before provider idempotency expires", async () => {
  const f = fixture();await rejects(() => dispatchPrepared(f.deps));
  const error = await rejects(() => dispatchPrepared({ ...f.deps, now: Date.parse(f.outbox.first_send_at!) + 23 * 3_600_000 }));
  assert(error instanceof DeliveryNeedsReview);assert(f.calls === 1);
});

Deno.test("outbox insert failure prevents email submission", async () => {
  const f = fixture();await rejects(() => dispatchPrepared({ ...f.deps, freeze: async () => { throw new Error("database offline"); } }));assert(f.calls === 0);
});

Deno.test("combined encoded attachment budget is enforced across editions", async () => {
  await rejects(() => checkAttachmentBudget([{ content: "x".repeat(8_100_000) }, { content: "y".repeat(8_100_000) }]), "too large");
  checkAttachmentBudget([{ content: "small" }]);
});
