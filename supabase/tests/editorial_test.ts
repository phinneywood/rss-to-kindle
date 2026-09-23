import { applyEditorialPlan, editorializeIssue, type EditorialPlan } from "../functions/_shared/editorial.ts";
import type { EpubArticle } from "../functions/_shared/epub.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function article(index: number, sectionId: string, sectionName: string, title: string): EpubArticle {
  return {
    title,
    url: `https://example.com/${index}`,
    canonical_url: `https://example.com/${index}`,
    source: "Example",
    author: null,
    published_at: "2026-09-23T12:00:00Z",
    excerpt: `${title} excerpt`,
    body: `<p>ORIGINAL-${index}: ${title}. This body must survive editorial processing unchanged.</p>`,
    assets: [],
    warnings: [],
    article_hash: `hash-${index}`,
    feed_id: `feed-${index}`,
    section_id: sectionId,
    section_name: sectionName,
  };
}

Deno.test("section editor groups accepted articles without moving, omitting, or rewriting them", () => {
  const input = [
    article(1, "ai", "AI", "Agent reliability"),
    article(2, "ai", "AI", "Agent observability"),
    article(3, "systems", "Systems", "Database internals"),
  ];
  const bodies = new Map(input.map((item) => [item.article_hash, item.body]));
  const plan: EditorialPlan = {
    articles: [
      { id: "article-1", topic_name: "Production agents", topic_intro: "Two pieces cover production agent operations." },
      { id: "article-2", topic_name: "Production agents", topic_intro: "Two pieces cover production agent operations." },
      { id: "article-3", topic_name: "Database architecture", topic_intro: "A standalone systems piece." },
    ],
  };
  const result = applyEditorialPlan(input, plan);
  assert(result.articles.length === input.length, "section editor must return every accepted article");
  assert(result.topics === 2, "topics should be counted by section and title");
  assert(result.articles[2].section_id === "systems", "section editor must not reroute articles");
  for (const item of result.articles) assert(item.body === bodies.get(item.article_hash), "section editor must not rewrite article bodies");
});

Deno.test("section editor uses GPT-6 Luna structured output for topic organization", async () => {
  const input = [article(1, "ai", "AI", "Agent reliability")];
  let requestBody: any = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    const plan: EditorialPlan = {
      articles: [{ id: "article-1", topic_name: "Production agents", topic_intro: "A production-agent update." }],
    };
    return Response.json({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(plan) }] }],
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    });
  }) as typeof fetch;

  const result = await editorializeIssue(input, {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 30_000,
  });
  assert(requestBody?.model === "gpt-6-luna", "Luna should remain the section editor");
  assert(requestBody?.text?.format?.name === "morning_reader_editorial_plan", "editor should use a dedicated strict schema");
  assert(requestBody?.text?.format?.schema?.properties?.articles?.minItems === input.length, "editor schema must require one output per accepted article");
  assert(requestBody?.text?.format?.schema?.properties?.articles?.maxItems === input.length, "editor schema must reject short or long article arrays");
  assert(JSON.stringify(requestBody?.text?.format?.schema?.properties?.articles?.items?.properties?.id?.enum) === JSON.stringify(["article-1"]), "editor schema must restrict ids to accepted articles");
  assert(!JSON.stringify(requestBody).includes('"include"'), "editor contract must not contain inclusion decisions");
  assert(!JSON.stringify(requestBody).includes('"section_name"'), "editor contract must not contain section routing decisions");
  assert(!JSON.stringify(requestBody).includes('"article_note"'), "editor contract must not generate per-article framing notes");
  assert(result.report.status === "edited", "valid topic plan should be applied");
  assert(result.articles[0].editorial_topic === "Production agents", "topic metadata should be attached");
  assert((result.articles[0].editorial_topic_intro || "").length <= 180, "topic intro should remain compact");
});

Deno.test("section editor failure preserves assigned articles as a flat conventional issue", async () => {
  const input = [article(1, "ai", "AI", "Agent reliability")];
  const fetchImpl = (async () => new Response("provider unavailable", { status: 503 })) as typeof fetch;
  const result = await editorializeIssue(input, {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 30_000,
  });
  assert(result.report.status === "fallback", "editor failure should be explicit");
  assert(result.articles.length === input.length, "editor failure must not drop articles");
  assert(result.articles[0].section_id === "ai", "editor failure must not undo assignment");
});

Deno.test("invalid topic plans cannot silently duplicate or lose accepted articles", () => {
  const input = [article(1, "ai", "AI", "One"), article(2, "ai", "AI", "Two")];
  const invalid: EditorialPlan = {
    articles: [
      { id: "article-1", topic_name: "Topic", topic_intro: "Intro" },
      { id: "article-1", topic_name: "Topic", topic_intro: "Intro" },
    ],
  };
  let threw = false;
  try { applyEditorialPlan(input, invalid); } catch { threw = true; }
  assert(threw, "duplicate or missing topic decisions must invalidate the whole plan");
});
