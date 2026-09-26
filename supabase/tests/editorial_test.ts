import { applyEditorialPlan, editorializeIssue, type EditorialPlan } from "../functions/_shared/editorial.ts";
import type { EpubArticle } from "../functions/_shared/epub.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function article(index: number, title: string): EpubArticle {
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
    section_id: `legacy-${index}`,
    section_name: `Legacy ${index}`,
  };
}

Deno.test("issue organizer places every eligible article exactly once without rewriting content", () => {
  const input = [
    article(1, "Agent reliability"),
    article(2, "Agent observability"),
    article(3, "Database internals"),
    article(4, "An unrelated essay"),
  ];
  const bodies = new Map(input.map((item) => [item.article_hash, item.body]));
  const plan: EditorialPlan = {
    articles: [
      { id: "article-2", section_name: "Production AI", topic_name: "Operating agents" },
      { id: "article-1", section_name: "Production AI", topic_name: "Operating agents" },
      { id: "article-3", section_name: "Systems", topic_name: null },
      { id: "article-4", section_name: "Other", topic_name: null },
    ],
  };
  const result = applyEditorialPlan(input, plan);
  assert(result.articles.length === input.length, "organizer must return every eligible article");
  assert(result.articles[0].title === "Agent observability", "plan order should become reading order");
  assert(result.articles[0].section_name === "Production AI" && result.articles[1].section_name === "Production AI");
  assert(result.articles[2].section_name === "Other", "singleton dynamic sections should collapse into Other");
  assert(result.articles[3].section_name === "Other", "explicit Other must remain Other");
  assert(result.other === 2, "Other count should include singleton fallback and explicit Other");
  assert(result.topics === 1, "only genuine multi-article clusters should count as topics");
  assert(result.articles.every((item) => item.section_id == null), "legacy source sections must not survive organization");
  for (const item of result.articles) assert(item.body === bodies.get(item.article_hash), "organizer must not rewrite article bodies");
});

Deno.test("organizer uses GPT-6 Luna structured output and cannot express omission", async () => {
  const input = [article(1, "Agent reliability"), article(2, "Agent observability")];
  let requestBody: any = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    const plan: EditorialPlan = {
      articles: [
        { id: "article-1", section_name: "Production AI", topic_name: "Operating agents" },
        { id: "article-2", section_name: "Production AI", topic_name: "Operating agents" },
      ],
    };
    return Response.json({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(plan) }] }],
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    });
  }) as typeof fetch;

  const result = await editorializeIssue(input, {
    apiKey: "test-key",
    editorialBrief: "Software systems and thoughtful technical writing.",
    additionalInstructions: "Prefer concrete technical labels and primary-source framing.",
    fetchImpl,
    deadline: Date.now() + 30_000,
  });
  assert(requestBody?.model === "gpt-6-luna", "Luna should remain the issue organizer");
  assert(requestBody?.text?.format?.name === "morning_reader_issue_organization");
  assert(requestBody?.text?.format?.schema?.properties?.articles?.minItems === input.length);
  assert(requestBody?.text?.format?.schema?.properties?.articles?.maxItems === input.length);
  const props = requestBody?.text?.format?.schema?.properties?.articles?.items?.properties || {};
  assert(Object.keys(props).sort().join(",") === "id,section_name,topic_name", "organizer schema should expose placement only");
  assert(!("include" in props) && !("omit" in props) && !("label" in props), "organizer schema must not offer an omission decision");
  const serialized = JSON.stringify(requestBody);
  assert(serialized.includes("MUST appear in the issue exactly once"), "prompt must state the all-eligible invariant");
  assert(serialized.includes("Your job is organization, not filtering"), "prompt must prohibit relevance filtering");
  assert(serialized.includes("Other"), "prompt must define the Other fallback");
  assert(serialized.includes("may NEVER be used to exclude"), "reader brief must not become a relevance filter");
  assert(serialized.includes("Prefer concrete technical labels and primary-source framing."), "additional editor instructions should reach the organizer");
  assert(serialized.includes("subordinate to every fixed rule"), "user instructions must be explicitly lower priority than the fixed contract");
  assert(result.report.status === "edited");
  assert(result.articles.length === input.length);
});

Deno.test("organizer failure preserves every eligible article in Other", async () => {
  const input = [article(1, "Agent reliability"), article(2, "Unusual essay")];
  const fetchImpl = (async () => new Response("provider unavailable", { status: 503 })) as typeof fetch;
  const result = await editorializeIssue(input, {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 30_000,
  });
  assert(result.report.status === "fallback", "editor failure should be explicit");
  assert(result.articles.length === input.length, "editor failure must not drop articles");
  assert(result.articles.every((item) => item.section_name === "Other" && item.section_id == null), "fallback should remain structurally valid");
});

Deno.test("overlong labels are rejected instead of leaking into the publication", () => {
  const input = [article(1, "One")];
  const invalid: EditorialPlan = {
    articles: [{ id: "article-1", section_name: "This section label is deliberately much too long and contains far more than eight separate words", topic_name: null }],
  };
  let threw = false;
  try { applyEditorialPlan(input, invalid); } catch { threw = true; }
  assert(threw, "overlong labels should invalidate the editorial plan");
});

Deno.test("invalid plans cannot silently duplicate or lose eligible articles", () => {
  const input = [article(1, "One"), article(2, "Two")];
  const invalid: EditorialPlan = {
    articles: [
      { id: "article-1", section_name: "Topic", topic_name: null },
      { id: "article-1", section_name: "Topic", topic_name: null },
    ],
  };
  let threw = false;
  try { applyEditorialPlan(input, invalid); } catch { threw = true; }
  assert(threw, "duplicate or missing decisions must invalidate the whole plan");
});
