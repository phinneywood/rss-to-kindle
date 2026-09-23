import { plainText } from "./article.ts";
import type { EpubArticle } from "./epub.ts";

export type EditorialDecision = {
  id: string;
  topic_name: string;
  topic_intro: string;
  article_note: string;
};

export type EditorialPlan = { articles: EditorialDecision[] };

export type EditorialReport = {
  status: "edited" | "skipped" | "fallback";
  model: string;
  topics: number;
  error?: string;
  usage?: Record<string, unknown>;
};

export type EditorializedArticle = EpubArticle & {
  editorial_topic?: string | null;
  editorial_topic_intro?: string | null;
  editorial_note?: string | null;
  editorial_position?: number | null;
};

const DEFAULT_MODEL = "gpt-6-luna";

function candidateId(index: number) {
  return `article-${index + 1}`;
}

function outputText(payload: any): string {
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
      if (part?.type === "refusal") throw new Error("OpenAI refused the editorial request.");
    }
  }
  throw new Error("OpenAI returned no structured editorial output.");
}

function schemaFor(articleIds: string[]) {
  return {
    type: "object",
    properties: {
      articles: {
        type: "array",
        minItems: articleIds.length,
        maxItems: articleIds.length,
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: articleIds },
            topic_name: { type: "string" },
            topic_intro: { type: "string" },
            article_note: { type: "string" },
          },
          required: ["id", "topic_name", "topic_intro", "article_note"],
          additionalProperties: false,
        },
      },
    },
    required: ["articles"],
    additionalProperties: false,
  };
}

export function applyEditorialPlan(
  articles: EpubArticle[],
  plan: EditorialPlan,
): { articles: EditorializedArticle[]; topics: number } {
  const expected = new Set(articles.map((_article, index) => candidateId(index)));
  const seen = new Set<string>();
  const output: EditorializedArticle[] = [];
  const topics = new Set<string>();

  if (!plan || !Array.isArray(plan.articles) || plan.articles.length !== articles.length) {
    throw new Error("Editorial plan did not return exactly one decision for every accepted article.");
  }

  for (const decision of plan.articles) {
    if (!expected.has(decision.id) || seen.has(decision.id)) {
      throw new Error("Editorial plan contained an unknown or duplicate article id.");
    }
    seen.add(decision.id);
    const index = Number(decision.id.slice("article-".length)) - 1;
    const article = articles[index];
    if (!article) throw new Error("Editorial plan referenced an invalid article.");

    const topic = String(decision.topic_name || "").trim();
    const intro = String(decision.topic_intro || "").trim();
    const note = String(decision.article_note || "").trim();
    if (!topic || !intro || !note) throw new Error("Editorial plan omitted required reader-facing copy.");

    topics.add(`${article.section_id || article.section_name || ""}:${topic}`);
    output.push({
      ...article,
      editorial_topic: topic,
      editorial_topic_intro: intro,
      editorial_note: note,
      editorial_position: output.length,
    });
  }

  if (seen.size !== expected.size) throw new Error("Editorial plan omitted one or more accepted articles.");
  return { articles: output, topics: topics.size };
}

export async function editorializeIssue(
  articles: EpubArticle[],
  options: {
    apiKey?: string;
    model?: string;
    deadline?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ articles: EditorializedArticle[]; report: EditorialReport }> {
  const model = options.model || DEFAULT_MODEL;
  if (!articles.length) return { articles, report: { status: "skipped", model, topics: 0 } };

  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    return { articles, report: { status: "skipped", model, topics: 0, error: "OPENAI_API_KEY is not configured." } };
  }

  const deadline = options.deadline ?? Date.now() + 30_000;
  const remaining = deadline - Date.now();
  if (remaining < 8_000) {
    return { articles, report: { status: "skipped", model, topics: 0, error: "Not enough preparation time remained for editorial organization." } };
  }

  const candidates = articles.map((article, index) => ({
    id: candidateId(index),
    section: article.section_name || "",
    title: article.title,
    source: article.source,
    author: article.author || "",
    excerpt: article.excerpt || "",
    text: plainText(article.body).slice(0, 2200),
  }));

  const system = [
    "You are the section editor for Morning Reader, a personal daily newspaper.",
    "The assignment desk has already decided which articles belong and which section each belongs in.",
    "Do not omit articles and do not move articles between sections.",
    "Within each section, group related coverage into specific topical clusters and choose a useful reading order.",
    "Singleton topics are valid. Never force unrelated articles together.",
    "Write a brief 1-2 sentence topic introduction explaining what the grouped articles cover and how their contributions differ.",
    "Write one short sentence for each article explaining what that article specifically covers or contributes.",
    "Do not synthesize the sources into a replacement article. Do not rewrite article bodies. Do not add facts unsupported by the supplied text.",
    "Return every input id exactly once, ordered in the reading order you recommend while keeping articles within their assigned sections.",
  ].join("\n");

  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(25_000, remaining - 3_000))),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 8_000,
        input: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify({ candidates }) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "morning_reader_editorial_plan",
            strict: true,
            schema: schemaFor(candidates.map((candidate) => candidate.id)),
          },
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenAI editorial request failed (${response.status}): ${raw.slice(0, 300)}`);
    const payload = JSON.parse(raw);
    const applied = applyEditorialPlan(articles, JSON.parse(outputText(payload)) as EditorialPlan);
    return {
      articles: applied.articles,
      report: {
        status: "edited",
        model,
        topics: applied.topics,
        usage: payload.usage || undefined,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      articles,
      report: {
        status: "fallback",
        model,
        topics: 0,
        error: message.slice(0, 500),
      },
    };
  }
}
