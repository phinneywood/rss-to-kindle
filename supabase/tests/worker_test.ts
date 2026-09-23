// Full worker orchestration with real extraction/EPUB generation. All HTTP is
// replaced in-process: no credentials, production records or emails are used.
Deno.env.set("SUPABASE_URL", "https://database.example.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only-key");
Deno.env.set("RESEND_API_KEY", "test-only-key");
Deno.env.set("OPENAI_API_KEY", "test-only-key");
const { processJob, handleWorkerRequest } = await import("../functions/worker/core.ts");
function assert(value: unknown, message = "Assertion failed"): asserts value { if (!value) throw new Error(message); }

async function scenario(mode: "empty" | "failed" | "partial" | "retry" | "scheduled" | "rescheduled" | "test" | "classified") {
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
    if (url.hostname === "api.openai.com") {
      const payload = JSON.parse(await req.text());
      const format = payload?.text?.format?.name;
      const userContent = JSON.parse(payload?.input?.at(-1)?.content || "{}");
      if (format === "morning_reader_assignment_plan") {
        const plan = {
          articles: (userContent.candidates || []).map((candidate: any) => ({
            id: candidate.id,
            label: candidate.title === "Drop me" ? "OMIT" : (candidate.current_section || "Reading"),
            confidence: candidate.title === "Drop me" ? 0.99 : 0.95,
            reason: candidate.title === "Drop me" ? "Fixture marks this article out of scope." : "Fixture keeps the article in its assigned section.",
          })),
        };
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(plan) }] }], usage: { input_tokens: 10, output_tokens: 10 } });
      }
      if (format === "morning_reader_editorial_plan") {
        const plan = {
          articles: (userContent.candidates || []).map((candidate: any) => ({
            id: candidate.id,
            topic_name: "Fixture topic",
            topic_intro: "Fixture introduction.",
            article_note: "Fixture article note.",
          })),
        };
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(plan) }] }], usage: { input_tokens: 10, output_tokens: 10 } });
      }
      return new Response("unexpected OpenAI request", { status: 400 });
    }
    if (url.hostname === "8.8.8.8") {
      fetched.push(url.pathname);
      if (url.pathname === "/broken") return new Response("Unavailable", { status: 503 });
      if (url.pathname.endsWith(".png")) return new Response(new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
      if (mode === "classified" && url.pathname === "/feed") {
        const body = "Substantial original reading text. ".repeat(24);
        return new Response(`<rss><channel>
          <item><title>Keep me</title><link>https://8.8.8.8/keep-article</link><content:encoded><![CDATA[<p>${body}</p><img src="https://8.8.8.8/keep.png" alt="Keep">]]></content:encoded></item>
          <item><title>Drop me</title><link>https://8.8.8.8/drop-article</link><content:encoded><![CDATA[<p>${body}</p><img src="https://8.8.8.8/drop.png" alt="Drop">]]></content:encoded></item>
        </channel></rss>`);
      }
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
  assert(result.job.result.editorial?.assignment?.status === "assigned", "assignment diagnostics must survive outbox freezing");
  assert(result.job.result.editorial?.organization?.status === "edited", "section-editor diagnostics must survive outbox freezing");
  assert(result.outbox.payload.editorial?.assignment?.status === "assigned", "frozen outbox must retain assignment diagnostics");
  assert(result.outbox.payload.editorial?.organization?.status === "edited", "frozen outbox must retain section-editor diagnostics");
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


Deno.test("assignment happens before image hydration so omitted articles never fetch media", async () => {
  const result = await scenario("classified");
  assert(result.job.status === "sent", JSON.stringify(result.first));
  assert(result.job.result.articles === 1, "only the included article should be delivered");
  assert(result.fetched.includes("/keep.png"), "included article image should be hydrated");
  assert(!result.fetched.includes("/drop.png"), "omitted article image must never be fetched");
  assert(result.job.result.editorial.assignment.omitted === 1, "assignment diagnostics should record the omitted candidate");
});
