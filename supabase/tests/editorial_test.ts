import { applyEditorialPlan, editorializeIssue, type EditorialPlan } from "../functions/_shared/editorial.ts";
import type { EpubArticle } from "../functions/_shared/epub.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const sections = [
  { id: "ai", name: "AI" },
  { id: "org", name: "Organizations & human behavior" },
];

function article(index: number, sectionId: string, title: string, source = "Example"): EpubArticle {
  return {
    title,
    url: `https://example.com/${index}`,
    canonical_url: `https://example.com/${index}`,
    source,
    author: null,
    published_at: "2026-09-23T12:00:00Z",
    excerpt: `${title} excerpt`,
    body: `<p>ORIGINAL-${index}: ${title}. This body must survive editorial processing unchanged.</p>`,
    assets: [],
    warnings: [],
    article_hash: `hash-${index}`,
    feed_id: `feed-${index}`,
    section_id: sectionId,
  };
}

Deno.test("editor applies article-level section fit, topic grouping, singleton topics, and preserves article bodies", () => {
  const input = [
    article(1, "ai", "Agent reliability reaches production"),
    article(2, "ai", "Observability for long-running agents"),
    article(3, "ai", "A repost about office politics", "Outside Journal"),
    article(4, "org", "How teams adopt AI tools"),
    article(5, "ai", "A standalone model release"),
  ];
  const originalBodies = new Map(input.map((item) => [item.article_hash, item.body]));
  const plan: EditorialPlan = {
    articles: [
      {
        id: "article-1",
        include: true,
        section_name: "AI",
        topic_name: "Agent reliability moves into production",
        topic_intro: "Two articles examine reliability and observability as agents move from demos into long-running production systems.",
        article_note: "Focuses on failure modes and reliability controls for production agents.",
        decision_reason: "Direct fit for AI and the same concrete production-agent topic as article-2.",
      },
      {
        id: "article-2",
        include: true,
        section_name: "AI",
        topic_name: "Agent reliability moves into production",
        topic_intro: "Two articles examine reliability and observability as agents move from demos into long-running production systems.",
        article_note: "Covers observability practices for long-running agent workflows.",
        decision_reason: "Direct fit for AI and complements article-1.",
      },
      {
        id: "article-4",
        include: true,
        section_name: "Organizations & human behavior",
        topic_name: "Organizations adapt to AI tools",
        topic_intro: "This piece looks at how teams change their routines and coordination as AI tools enter everyday work.",
        article_note: "Examines organizational adoption and workflow change.",
        decision_reason: "Fits the organizations section rather than the AI technology section.",
      },
      {
        id: "article-5",
        include: true,
        section_name: "AI",
        topic_name: "A new model release",
        topic_intro: "A standalone update on a newly released AI model.",
        article_note: "Reports the model release and its main technical changes.",
        decision_reason: "Direct AI fit; no second article is needed to justify a singleton topic.",
      },
      {
        id: "article-3",
        include: false,
        section_name: "",
        topic_name: "",
        topic_intro: "",
        article_note: "",
        decision_reason: "The linked article is about office politics and does not fit either enabled section.",
      },
    ],
  };

  const result = applyEditorialPlan(sections, input, plan);
  assert(result.articles.length === 4, "one off-topic article should be omitted");
  assert(result.report.omitted === 1, "omission count should be recorded");
  assert(result.report.topics === 3, "two grouped topics plus one singleton should be counted");
  assert(result.articles.filter((item) => item.editorial_topic === "Agent reliability moves into production").length === 2, "related articles should share a topic");
  assert(result.articles.some((item) => item.editorial_topic === "A new model release"), "singleton topics must be allowed");
  assert(!result.articles.some((item) => item.title === "A repost about office politics"), "off-topic repost must be removed");

  for (const item of result.articles) {
    assert(item.body === originalBodies.get(item.article_hash), `article body changed for ${item.title}`);
  }
});

Deno.test("editor uses GPT-6 Luna Responses structured output and keeps generated copy separate from source bodies", async () => {
  const input = [
    article(1, "ai", "Agent reliability reaches production"),
    article(2, "ai", "Observability for long-running agents"),
  ];
  let requestBody: any = null;
  const fetchImpl = (async (inputUrl: RequestInfo | URL, init?: RequestInit) => {
    assert(String(inputUrl) === "https://api.openai.com/v1/responses", "editorial call must use the Responses API");
    requestBody = JSON.parse(String(init?.body || "{}"));
    const plan: EditorialPlan = {
      articles: [
        {
          id: "article-1",
          include: true,
          section_name: "AI",
          topic_name: "Production agents",
          topic_intro: "Two articles cover the operational shift from agent demos to production systems.",
          article_note: "Covers production reliability controls.",
          decision_reason: "Direct section fit.",
        },
        {
          id: "article-2",
          include: true,
          section_name: "AI",
          topic_name: "Production agents",
          topic_intro: "Two articles cover the operational shift from agent demos to production systems.",
          article_note: "Covers observability for long-running agents.",
          decision_reason: "Direct section fit.",
        },
      ],
    };
    return Response.json({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(plan) }] }],
      usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
    });
  }) as typeof fetch;

  const result = await editorializeIssue(sections, input, {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 30_000,
  });

  assert(requestBody?.model === "gpt-6-luna", "GPT-6 Luna must be the default editorial model");
  assert(requestBody?.store === false, "editorial responses should not be stored by OpenAI");
  assert(requestBody?.text?.format?.type === "json_schema", "structured output must use a JSON schema");
  assert(requestBody?.text?.format?.strict === true, "structured output schema must be strict");
  assert(requestBody?.reasoning?.effort === "low", "editorial classification should use low reasoning effort");
  assert(result.report.status === "edited", "successful response should produce an edited issue");
  assert(result.articles[0].body === input[0].body && result.articles[1].body === input[1].body, "model output must not replace article bodies");
  assert(result.articles[0].editorial_note?.includes("reliability"), "article framing should be attached as metadata");
});

Deno.test("editorial API failure falls back to the conventional issue without dropping articles", async () => {
  const input = [
    article(1, "ai", "Agent reliability reaches production"),
    article(2, "org", "How teams coordinate"),
  ];
  const fetchImpl = (async () => new Response("provider unavailable", { status: 503 })) as typeof fetch;
  const result = await editorializeIssue(sections, input, {
    apiKey: "test-key",
    fetchImpl,
    deadline: Date.now() + 30_000,
  });

  assert(result.report.status === "fallback", "API failure should be recorded as a fallback");
  assert(result.articles.length === input.length, "fallback must retain every article");
  assert(result.articles.every((item, index) => item.body === input[index].body), "fallback must preserve original article bodies");
});

Deno.test("invalid editorial plans cannot silently drop or duplicate articles", () => {
  const input = [
    article(1, "ai", "One"),
    article(2, "ai", "Two"),
  ];
  const invalid: EditorialPlan = {
    articles: [
      {
        id: "article-1",
        include: true,
        section_name: "AI",
        topic_name: "Topic",
        topic_intro: "Intro",
        article_note: "Note",
        decision_reason: "Reason",
      },
      {
        id: "article-1",
        include: false,
        section_name: "",
        topic_name: "",
        topic_intro: "",
        article_note: "",
        decision_reason: "Duplicate",
      },
    ],
  };

  let threw = false;
  try {
    applyEditorialPlan(sections, input, invalid);
  } catch {
    threw = true;
  }
  assert(threw, "duplicate or missing article decisions must invalidate the entire plan");
});
