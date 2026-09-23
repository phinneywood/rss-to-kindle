// Full worker orchestration with real extraction/EPUB generation. All HTTP is
// replaced in-process: no credentials, production records or emails are used.
Deno.env.set("SUPABASE_URL", "https://database.example.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only-key");
Deno.env.set("RESEND_API_KEY", "test-only-key");
const { processJob, handleWorkerRequest } = await import("../functions/worker/core.ts");
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }

async function scenario(mode: "empty" | "failed" | "partial" | "retry" | "scheduled" | "rescheduled" | "test") {
  const original = globalThis.fetch;
  const job: any = { id: "job-1", user_id: "user-1", status: "queued", attempts: mode === "failed" ? 2 : 0, reason: "manual", created_at: new Date().toISOString(), lookback_hours: 168 };
  if(mode === "scheduled" || mode === "rescheduled")Object.assign(job,{reason:"scheduled",section_id:"section-1",schedule_version:1,lookback_hours:192});
  if(mode === "test")Object.assign(job,{reason:"test",lookback_hours:168});
  let outbox: any = null, sends = 0, failFinalUpdate = mode === "retry";
  const feedUpdates: any[] = [];
  const good = { id: "feed-1", user_id: job.user_id, section_id: "section-1", name: "Example", url: "https://8.8.8.8/feed" };
  const bad = { ...good, id: "feed-2", name: "Broken source", url: "https://8.8.8.8/broken" };
  const feeds = mode === "empty" ? [] : mode === "failed" ? [bad] : mode === "partial" ? [good, bad] : mode === "scheduled" ? [good,{...bad,section_id:"section-2"}] : [good];
  const fetched: string[]=[];
  let articleDeliveryReads = 0, articleDeliveryWrites = 0;
  const snapshots: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.hostname === "api.resend.com") { sends++;snapshots.push(await req.text());return Response.json({ id: "email-1" }); }
    if (url.hostname === "8.8.8.8") {
      fetched.push(url.pathname);
      if (url.pathname === "/broken") return new Response("Unavailable", { status: 503 });
      return new Response(`<rss><channel><item><title>Example article</title><link>https://8.8.8.8/article</link>${mode==='scheduled'?`<pubDate>${new Date(Date.now()-5*86400_000).toUTCString()}</pubDate>`:''}<content:encoded><![CDATA[<p>${"Substantial original reading text. ".repeat(24)}</p>]]></content:encoded></item></channel></rss>`);
    }
    assert(url.hostname === "database.example.invalid", "Unexpected network call " + url.hostname);
    const table = url.pathname.split('/').at(-1);
    const body = req.method === "GET" ? null : await req.json();
    let rows: any[] = [];
    if (table === "digest_jobs") {
      if (body?.status === "sent" && failFinalUpdate) { failFinalUpdate = false;return Response.json({ message: "Final status database failure" }, { status: 500 }); }
      if (body) Object.assign(job, body);
      rows = [structuredClone(job)];
    } else if (table === "delivery_outbox") {
      if (req.method === "POST") outbox = { ...body, first_send_at: null, provider_email_id: null };
      if (req.method === "PATCH") Object.assign(outbox, body);
      rows = outbox ? [outbox] : [];
    } else if (table === "user_settings") rows = [{ kindle_email: "test@example.com", timezone: "UTC",paused:false,onboarding_complete:true }];
    else if (table === "sections") {
      rows = [{ id: "section-1", name: "Reading",enabled:true,delivery_days:[0,1,2,3,4,5,6] },{id:"section-2",name:"Other section",enabled:true,delivery_days:[]}];
      const idFilter = url.searchParams.get("id");
      if (idFilter?.startsWith("eq.")) rows = rows.filter(row => row.id === idFilter.slice(3));
    }
    else if (table === "feeds") { if (body) feedUpdates.push(body);else rows = feeds; }
    else if (table === "digests") rows = [{ id: "digest-1" }];
    else if (table === "pending_issue_articles") rows = [];
    else if (table === "article_deliveries") {
      if (req.method === "GET") articleDeliveryReads++;
      else articleDeliveryWrites++;
    }
    else throw new Error("Unexpected table: " + table);
    return Response.json(req.headers.get("accept")?.includes("vnd.pgrst.object") ? rows[0] : rows);
  }) as typeof fetch;
  try {
    const first = await processJob(structuredClone(job));
    if (mode === "retry") {
      assert(first?.status === "queued", JSON.stringify(first));
      await processJob(structuredClone(job));
    }
    return { first, job, outbox, sends, feedUpdates, snapshots, fetched, articleDeliveryReads, articleDeliveryWrites };
  } finally { globalThis.fetch = original; }
}

Deno.test("worker distinguishes an empty edition from failed sources", async () => {
  const empty = await scenario("empty"), failed = await scenario("failed");
  assert(empty.job.status === "empty");assert(failed.job.status === "failed", JSON.stringify(failed));
  assert(empty.sends === 0 && failed.sends === 0);assert(failed.job.error.includes("Broken source"));
});

Deno.test("worker submits partial editions and persists source omissions", async () => {
  const result = await scenario("partial");
  assert(result.job.status === "partial", JSON.stringify(result.first));assert(result.sends === 1);
  assert(result.job.result.articles === 1);assert(result.job.result.issues.some((x: string) => x.includes("Broken source")));
  assert(result.outbox.payload.email.attachments[0].filename.endsWith(".epub"));
});

Deno.test("worker reconciles accepted delivery without resending after final status failure", async () => {
  const result = await scenario("retry");
  assert(result.job.status === "sent", JSON.stringify(result.first));assert(result.sends === 1, "A reconciliation retry must not resubmit accepted mail");
});

Deno.test("a scheduled daily issue combines eligible sections into one EPUB",async()=>{
  const r=await scenario("scheduled");assert(r.job.status==='sent',JSON.stringify(r.first));assert(r.sends===1);
  assert(!r.fetched.includes('/broken'),"a section excluded today must not be fetched");
  assert(r.outbox.payload.email.attachments.length===1,"daily issue must have exactly one EPUB");
  assert(r.outbox.payload.email.attachments[0].filename.startsWith("morning-reader-"));
  assert(r.job.result.articles===1);
});

Deno.test("worker rejects requests without its configured authentication", async () => {
  const response = await handleWorkerRequest(new Request("https://worker.example.invalid", { method: "POST" }));
  assert(response.status === 401);
});

Deno.test("stale recovery terminalizes exhausted jobs and requeues retryable jobs", async () => {
  const original = globalThis.fetch;
  const updates: { query: string; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.pathname.includes('/rpc/')) return Response.json(true);
    if (req.method === 'PATCH') updates.push({ query: url.search, body: await req.json() });
    return Response.json([]);
  }) as typeof fetch;
  try {
    const response = await handleWorkerRequest(new Request("https://worker.example.invalid", { method: "POST", headers: { "x-worker-secret": "fake-test-secret" } }));
    assert(response.status === 200);
    assert(updates.some(u => u.query.includes('attempts=lt.3') && u.body.status === 'queued'));
    assert(updates.some(u => u.query.includes('attempts=gte.3') && u.body.status === 'failed' && u.body.finished_at));
  } finally { globalThis.fetch = original; }
});


Deno.test("explicit test sends replay recent articles without consuming recurring delivery history", async () => {
  const result = await scenario("test");
  assert(result.job.status === "sent", JSON.stringify(result.first));
  assert(result.sends === 1, "test send should still deliver a real EPUB");
  assert(result.articleDeliveryReads === 0, "test send should not suppress articles based on recurring delivery history");
  assert(result.articleDeliveryWrites === 0, "test send should not consume articles from future recurring issues");
});
