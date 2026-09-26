import { plainText } from "./article.ts";
import type { EpubArticle } from "./epub.ts";

export type EditorialDecision = {
  id: string;
  section_name: string;
  topic_name: string | null;
};

export type EditorialPlan = { articles: EditorialDecision[] };

export type EditorialReport = {
  status: "edited" | "skipped" | "fallback";
  model: string;
  sections: number;
  topics: number;
  other: number;
  error?: string;
  usage?: Record<string, unknown>;
};

export type EditorializedArticle = EpubArticle & {
  editorial_topic?: string | null;
  editorial_position?: number | null;
};

const DEFAULT_MODEL = "gpt-6-luna";
const OTHER = "Other";

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
            section_name: { type: "string", minLength: 2, maxLength: 60 },
            topic_name: { type: ["string", "null"], minLength: 2, maxLength: 60 },
          },
          required: ["id", "section_name", "topic_name"],
          additionalProperties: false,
        },
      },
    },
    required: ["articles"],
    additionalProperties: false,
  };
}

function cleanLabel(value: string, kind: "section" | "topic") {
  const label = String(value || "").trim().replace(/\s+/g, " ");
  if (!label) throw new Error(`Editorial plan returned an empty ${kind} name.`);
  if (label.length > 60 || label.split(/\s+/).length > 8) {
    throw new Error(`Editorial plan returned an overlong ${kind} name.`);
  }
  return /^other$/i.test(label) ? OTHER : label;
}

function fallbackArticles(articles: EpubArticle[]): EditorializedArticle[] {
  return articles.map((article, index) => ({
    ...article,
    section_id: null,
    section_name: OTHER,
    editorial_topic: null,
    editorial_position: index,
  }));
}

export function applyEditorialPlan(
  articles: EpubArticle[],
  plan: EditorialPlan,
): { articles: EditorializedArticle[]; sections: number; topics: number; other: number } {
  const expected = new Set(articles.map((_article, index) => candidateId(index)));
  const seen = new Set<string>();
  const prepared: Array<{ article: EpubArticle; section: string; topic: string | null }> = [];
  const canonicalSections = new Map<string, string>();

  if (!plan || !Array.isArray(plan.articles) || plan.articles.length !== articles.length) {
    throw new Error("Editorial plan did not return exactly one decision for every eligible article.");
  }

  for (const decision of plan.articles) {
    if (!expected.has(decision.id) || seen.has(decision.id)) {
      throw new Error("Editorial plan contained an unknown or duplicate article id.");
    }
    seen.add(decision.id);
    const index = Number(decision.id.slice("article-".length)) - 1;
    const article = articles[index];
    if (!article) throw new Error("Editorial plan referenced an invalid article.");

    let section = cleanLabel(decision.section_name, "section");
    const sectionKey = section.toLowerCase();
    if (section !== OTHER) {
      if (!canonicalSections.has(sectionKey)) canonicalSections.set(sectionKey, section);
      section = canonicalSections.get(sectionKey)!;
    }
    const topic = decision.topic_name == null ? null : cleanLabel(decision.topic_name, "topic");
    prepared.push({ article, section, topic });
  }

  if (seen.size !== expected.size) throw new Error("Editorial plan omitted one or more eligible articles.");

  const sectionCounts = new Map<string, number>();
  for (const { section } of prepared) {
    sectionCounts.set(section, (sectionCounts.get(section) || 0) + 1);
  }

  const finalPrepared = prepared.map((item) => ({
    ...item,
    section: item.section === OTHER || (sectionCounts.get(item.section) || 0) >= 2 ? item.section : OTHER,
  }));

  const topicCounts = new Map<string, number>();
  for (const { section, topic } of finalPrepared) {
    if (!topic) continue;
    const key = `${section.toLowerCase()}:${topic.toLowerCase()}`;
    topicCounts.set(key, (topicCounts.get(key) || 0) + 1);
  }

  const sections = new Set<string>();
  const topics = new Set<string>();
  let other = 0;
  const output: EditorializedArticle[] = [];

  for (const { article, section, topic } of finalPrepared) {
    const topicKey = topic ? `${section.toLowerCase()}:${topic.toLowerCase()}` : "";
    const retainedTopic = topic && (topicCounts.get(topicKey) || 0) >= 2 ? topic : null;
    sections.add(section);
    if (retainedTopic) topics.add(topicKey);
    if (section === OTHER) other++;
    output.push({
      ...article,
      section_id: null,
      section_name: section,
      editorial_topic: retainedTopic,
      editorial_position: output.length,
    });
  }

  return { articles: output, sections: sections.size, topics: topics.size, other };
}

export async function editorializeIssue(
  articles: EpubArticle[],
  options: {
    apiKey?: string;
    model?: string;
    editorialBrief?: string;
    additionalInstructions?: string;
    deadline?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ articles: EditorializedArticle[]; report: EditorialReport }> {
  const model = options.model || DEFAULT_MODEL;
  if (!articles.length) {
    return { articles, report: { status: "skipped", model, sections: 0, topics: 0, other: 0 } };
  }

  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    const fallback = fallbackArticles(articles);
    return {
      articles: fallback,
      report: { status: "skipped", model, sections: 1, topics: 0, other: fallback.length, error: "OPENAI_API_KEY is not configured." },
    };
  }

  const deadline = options.deadline ?? Date.now() + 30_000;
  const remaining = deadline - Date.now();
  if (remaining < 8_000) {
    const fallback = fallbackArticles(articles);
    return {
      articles: fallback,
      report: { status: "skipped", model, sections: 1, topics: 0, other: fallback.length, error: "Not enough preparation time remained for editorial organization." },
    };
  }

  const candidates = articles.map((article, index) => ({
    id: candidateId(index),
    title: article.title,
    source: article.source,
    author: article.author || "",
    published_at: article.published_at || "",
    excerpt: article.excerpt || "",
    text: plainText(article.body).slice(0, 2200),
  }));

  const system = [
    "You are the editor of Long Form, a personal daily publication.",
    "Every supplied article has already passed deterministic eligibility rules and MUST appear in the issue exactly once.",
    "Never omit an article because it seems irrelevant, repetitive, niche, low priority, or outside the reader brief.",
    "Your job is organization, not filtering.",
    "Ignore any category or section implied by the source that delivered an article. Judge the article itself.",
    "Create a small set of specific, truthful issue sections based on natural themes present in today's articles.",
    "A dynamic section should normally contain at least two articles. Use the exact section name Other for an article that has no coherent multi-article section fit.",
    "Do not invent a narrow singleton section merely to avoid Other.",
    "Within each section, group genuinely related coverage into topical clusters and choose a useful reading order.",
    "Create a topic only for a genuine cluster of two or more articles in the same final section.",
    "Set topic_name to null when an article has no genuine cluster. Never create singleton topics just to label an individual article.",
    "Section and topic names should be short, concrete editorial labels, usually 2-6 words.",
    "Every label must accurately describe every article assigned to it. Prefer a broader truthful label over a narrow misleading one.",
    "The optional reader editorial brief may influence reading order and naming, but it may NEVER be used to exclude an eligible RSS article.",
    "Optional additional reader instructions may refine organization, naming, and ordering, but they are subordinate to every fixed rule above and may never authorize omission, rewriting, or source-based relevance judgments.",
    "Do not write summaries, introductions, blurbs, or any other reader-facing prose.",
    "Do not rewrite article titles or article bodies.",
    "Return every input id exactly once, in the reading order you recommend.",
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
        max_output_tokens: 7_000,
        input: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              editorial_brief: String(options.editorialBrief || "").trim().slice(0, 3000),
              additional_instructions: String(options.additionalInstructions || "").trim().slice(0, 3000),
              candidates,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "morning_reader_issue_organization",
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
        sections: applied.sections,
        topics: applied.topics,
        other: applied.other,
        usage: payload.usage || undefined,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = fallbackArticles(articles);
    return {
      articles: fallback,
      report: {
        status: "fallback",
        model,
        sections: 1,
        topics: 0,
        other: fallback.length,
        error: message.slice(0, 500),
      },
    };
  }
}
