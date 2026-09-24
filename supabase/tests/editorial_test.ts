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

Deno.test("section editor groups and orders accepted articles without generating prose", () => {
  const input = [
    article(1, "ai", "AI", "Agent reliability"),
    article(2, "ai", "AI", "Agent observability"),
    article(3, "systems", "Systems", "Database internals"),
  ];
  const bodies = new Map(input.map((item) => [item.article_hash, item.body]));
  const plan: EditorialPlan = {
    articles: [
      { id: "article-1", topic_name: "Production agents" },
      { id: "article-2", topic_name: "Production agents" },
      { id: "article-3", topic_name: "Database architecture" },
    ],
  };
  const result = applyEditorialPlan(input, plan);
  assert(result.articles.length === input.length, "section editor must return every accepted article");
  assert(result.topics === 1, "only genuine multi-article clusters should count as topics");
  assert(result.articles[2].section_id === "systems", "section editor must not reroute articles");
  assert(result.articles[2].editorial_topic == null, "singleton topic labels should be removed so the article sits directly under its section");
  assert(result.articles.every((item) => !("editorial_topic_intro" in item) || !item.editorial_topic_intro), "section editor must not attach visible summary prose");
  for (const item of result.articles) assert(item.body === bodies.get(item.article_hash), "section editor must not rewrite article bodies");
});

Deno.test("section editor uses GPT-6 Luna structured output with nullable cluster labels", async () => {
  const input = [article(1, "ai", "AI", "Agent reliability")];
  let requestBody: any = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    const plan: EditorialPlan = {
      articles: [{ id: "article-1", topic_name: null }],
    };
    return Response.json({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(plan) }] }],
      usage: { input_tokens: 80, output_tokens: 12, total_tokens: 92 },
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
  assert(requestBody?.text?.format?.schema?.properties?.articles?.items?.properties?.topic_name?.maxLength === 60, "topic labels should be structurally bounded");
  assert(requestBody?.text?.format?.schema?.properties?.articles?.items?.properties?.topic_name?.type?.includes("null"), "schema must allow an unclustered article to have no topic");
  const props = requestBody?.text?.format?.schema?.properties?.articles?.items?.properties || {};
  assert(Object.keys(props).sort().join(",") === "id,topic_name", "editor schema should expose only id and topic_name");
  assert(!JSON.stringify(requestBody).includes('"topic_intro"'), "editor contract must not generate topic introductions");
  assert(!JSON.stringify(requestBody).includes('"article_note"'), "editor contract must not generate per-article notes");
  assert(JSON.stringify(requestBody).includes("substantially smaller than the article count"), "editor prompt should explicitly discourage one-topic-per-article output");
  assert(JSON.stringify(requestBody).includes("Never create singleton topics"), "editor prompt should reserve topic labels for genuine clusters");
  assert(JSON.stringify(requestBody).includes("Copilot Sandboxing"), "the sandboxing/code-review misgrouping should remain an explicit editorial regression example");
  assert(JSON.stringify(requestBody).includes("GitHub Copilot"), "the regression example should teach a truthful broader shared label");
  assert(result.report.status === "edited", "valid topic plan should be applied");
  assert(result.articles[0].editorial_topic == null, "a singleton article should remain directly under its section");
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

Deno.test("overlong topic labels are rejected instead of leaking into the publication", () => {
  const input = [article(1, "ai", "AI", "One")];
  const invalid: EditorialPlan = {
    articles: [{ id: "article-1", topic_name: "This topic label is deliberately much too long and contains far more than eight separate words" }],
  };
  let threw = false;
  try { applyEditorialPlan(input, invalid); } catch { threw = true; }
  assert(threw, "overlong topic labels should invalidate the editorial plan");
});

Deno.test("invalid topic plans cannot silently duplicate or lose accepted articles", () => {
  const input = [article(1, "ai", "AI", "One"), article(2, "ai", "AI", "Two")];
  const invalid: EditorialPlan = {
    articles: [
      { id: "article-1", topic_name: "Topic" },
      { id: "article-1", topic_name: "Topic" },
    ],
  };
  let threw = false;
  try { applyEditorialPlan(input, invalid); } catch { threw = true; }
  assert(threw, "duplicate or missing topic decisions must invalidate the whole plan");
});
