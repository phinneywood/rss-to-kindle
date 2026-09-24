import { plainText } from "./article.ts";
import type { EpubArticle } from "./epub.ts";

export type EditorialDecision = {
  id: string;
  topic_name: string | null;
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
            topic_name: { type: ["string", "null"], minLength: 2, maxLength: 60 },
          },
          required: ["id", "topic_name"],
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
  const prepared: Array<{ article: EpubArticle; topic: string | null }> = [];

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

    const topic = decision.topic_name == null ? null : String(decision.topic_name).trim();
    if (decision.topic_name != null && !topic) throw new Error("Editorial plan returned an empty topic name.");
    if (topic && (topic.length > 60 || topic.split(/\s+/).length > 8)) {
      throw new Error("Editorial plan returned an overlong topic name.");
    }
    prepared.push({ article, topic });
  }

  if (seen.size !== expected.size) throw new Error("Editorial plan omitted one or more accepted articles.");

  const topicCounts = new Map<string, number>();
  for (const { article, topic } of prepared) {
    if (!topic) continue;
    const key = `${article.section_id || article.section_name || ""}:${topic}`;
    topicCounts.set(key, (topicCounts.get(key) || 0) + 1);
  }

  for (const { article, topic } of prepared) {
    const key = topic ? `${article.section_id || article.section_name || ""}:${topic}` : "";
    const retainedTopic = topic && (topicCounts.get(key) || 0) >= 2 ? topic : null;
    if (retainedTopic) topics.add(key);
    output.push({
      ...article,
      editorial_topic: retainedTopic,
      editorial_position: output.length,
    });
  }

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
    "You are the section editor for Morning Reader, a personal daily publication.",
    "The assignment desk has already decided which articles belong and which section each belongs in.",
    "Do not omit articles and do not move articles between sections.",
    "Within each section, group related coverage into specific topical clusters and choose a useful reading order.",
    "Prefer a small number of coherent topics over one label per article. When a section has four or more articles, normally use about 2-5 topics total.",
    "Create a topic only for a genuine cluster of two or more articles in the same section.",
    "Set topic_name to null when an article has no genuine cluster. Never create singleton topics just to label an individual article.",
    "The topic count should usually be substantially smaller than the article count.",
    "Topic names should be short, concrete editorial labels, usually 2-6 words.",
    "Every topic label must accurately describe every article assigned to it. Prefer a broader shared label over a narrow label that only fits one member of the cluster.",
    "Regression example: if one article is about Copilot sandboxing and another is about Copilot code-review configuration, a shared topic may be GitHub Copilot; do not call the shared topic Copilot Sandboxing.",
    "If no truthful shared label exists, split the articles rather than forcing them under a misleading topic.",
    "Do not write summaries, introductions, blurbs, or any other reader-facing prose.",
    "Do not rewrite article titles or article bodies.",
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
        max_output_tokens: 5_000,
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
