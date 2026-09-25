import type { EpubArticle } from "./epub.ts";

export type DiscoveryCandidate = {
  url: string;
  title: string;
  reason: string;
};

export type DiscoveryLaneReport = {
  kind: "related" | "open";
  status: "discovered" | "skipped" | "fallback";
  model: string;
  candidates: number;
  error?: string;
  usage?: Record<string, unknown>;
};

export type DiscoveryResult = {
  related: DiscoveryCandidate[];
  open: DiscoveryCandidate[];
  report: {
    related: DiscoveryLaneReport;
    open: DiscoveryLaneReport;
  };
};

const DEFAULT_MODEL = "gpt-6-luna";

function outputText(payload: any): string {
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
      if (part?.type === "refusal") throw new Error("OpenAI refused the discovery request.");
    }
  }
  throw new Error("OpenAI returned no structured discovery output.");
}

function candidateSchema() {
  return {
    type: "object",
    properties: {
      articles: {
        type: "array",
        minItems: 0,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            url: { type: "string", minLength: 8, maxLength: 1000 },
            title: { type: "string", minLength: 2, maxLength: 240 },
            reason: { type: "string", minLength: 2, maxLength: 500 },
          },
          required: ["url", "title", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["articles"],
    additionalProperties: false,
  };
}

function normalizedUrl(value: string) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function compactCore(articles: EpubArticle[]) {
  return articles.slice(0, 50).map((article) => ({
    title: article.title,
    source: article.source,
    section: article.section_name || "Other",
    topic: article.editorial_topic || null,
    published_at: article.published_at || null,
    url: article.canonical_url || article.url,
    excerpt: String(article.excerpt || "").slice(0, 500),
  }));
}

async function discoverLane(
  kind: "related" | "open",
  articles: EpubArticle[],
  editorialBrief: string,
  options: {
    apiKey?: string;
    model?: string;
    deadline: number;
    fetchImpl?: typeof fetch;
  },
): Promise<{ candidates: DiscoveryCandidate[]; report: DiscoveryLaneReport }> {
  const model = options.model || DEFAULT_MODEL;
  const brief = String(editorialBrief || "").trim().slice(0, 3000);
  if (!articles.length || (kind === "open" && !brief)) {
    return {
      candidates: [],
      report: { kind, status: "skipped", model, candidates: 0 },
    };
  }

  const apiKey = options.apiKey ?? Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!apiKey) {
    return {
      candidates: [],
      report: { kind, status: "skipped", model, candidates: 0, error: "OPENAI_API_KEY is not configured." },
    };
  }

  const remaining = options.deadline - Date.now();
  if (remaining < 12_000) {
    return {
      candidates: [],
      report: { kind, status: "skipped", model, candidates: 0, error: "Not enough preparation time remained for discovery." },
    };
  }

  const core = compactCore(articles);
  const existing = new Set(core.map((item) => normalizedUrl(item.url)).filter(Boolean) as string[]);
  const sectionNames = [...new Set(core.map((item) => item.section))];

  const relatedSystem = [
    "You are the Related Discovery editor for Morning Reader.",
    "Use web search to find zero to two excellent, publicly readable original articles OUTSIDE the reader's subscribed RSS corpus.",
    "Every recommendation must be directly related to a meaningful theme already present in today's organized RSS issue.",
    "Add something the RSS issue is missing: primary evidence, important context, a useful counterpoint, a follow-up, or an unusually strong treatment.",
    "Do not recommend a near-duplicate that merely repeats an article already present.",
    "Prefer durable, high-quality sources and direct article URLs. Never return a homepage, category page, RSS feed, search page, or URL already present in the issue.",
    "It is correct to return an empty list when nothing materially improves the issue.",
    "The reason must state what the article adds to today's existing coverage.",
  ].join("\n");

  const openSystem = [
    "You are the Open Discovery editor for Morning Reader.",
    "Use web search to find zero to two excellent, publicly readable original articles OUTSIDE the reader's subscribed RSS corpus.",
    "These recommendations must also be meaningfully OUTSIDE the topics and themes represented in today's organized RSS issue.",
    "Use the explicit editorial brief to choose broadly interesting, intellectually worthwhile, somewhat surprising reading.",
    "This lane is controlled serendipity, not an extension of today's RSS coverage.",
    "Reject recommendations whose main subject substantially overlaps today's sections, topics, or article themes.",
    "Prefer durable, high-quality sources and direct article URLs. Never return a homepage, category page, RSS feed, search page, or URL already present in the issue.",
    "It is correct to return an empty list when nothing clears both the quality and topical-distance bars.",
    "The reason must explain why the article fits the editorial brief despite being outside today's topics.",
  ].join("\n");

  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(18_000, remaining - 3_000))),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 2_500,
        tools: [{ type: "web_search", search_context_size: "low" }],
        input: [
          { role: "system", content: kind === "related" ? relatedSystem : openSystem },
          {
            role: "user",
            content: JSON.stringify({
              editorial_brief: brief,
              core_sections: sectionNames,
              core_articles: core,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: `morning_reader_${kind}_discovery`,
            strict: true,
            schema: candidateSchema(),
          },
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenAI discovery request failed (${response.status}): ${raw.slice(0, 300)}`);
    const payload = JSON.parse(raw);
    const parsed = JSON.parse(outputText(payload));
    if (!parsed || !Array.isArray(parsed.articles)) throw new Error("Discovery plan did not return an articles array.");

    const candidates: DiscoveryCandidate[] = [];
    const seen = new Set<string>();
    for (const rawCandidate of parsed.articles.slice(0, 2)) {
      const url = normalizedUrl(rawCandidate?.url);
      if (!url || existing.has(url) || seen.has(url)) continue;
      const title = String(rawCandidate?.title || "").trim().replace(/\s+/g, " ").slice(0, 240);
      const reason = String(rawCandidate?.reason || "").trim().replace(/\s+/g, " ").slice(0, 500);
      if (!title || !reason) continue;
      seen.add(url);
      candidates.push({ url, title, reason });
    }

    return {
      candidates,
      report: {
        kind,
        status: "discovered",
        model,
        candidates: candidates.length,
        usage: payload.usage || undefined,
      },
    };
  } catch (error) {
    return {
      candidates: [],
      report: {
        kind,
        status: "fallback",
        model,
        candidates: 0,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      },
    };
  }
}

export async function discoverBeyondRss(
  articles: EpubArticle[],
  editorialBrief: string,
  options: {
    apiKey?: string;
    model?: string;
    deadline?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DiscoveryResult> {
  const deadline = options.deadline ?? Date.now() + 35_000;
  const [related, open] = await Promise.all([
    discoverLane("related", articles, editorialBrief, { ...options, deadline }),
    discoverLane("open", articles, editorialBrief, { ...options, deadline }),
  ]);

  const relatedUrls = new Set(related.candidates.map((candidate) => normalizedUrl(candidate.url)).filter(Boolean));
  const openCandidates = open.candidates.filter((candidate) => !relatedUrls.has(normalizedUrl(candidate.url)));

  return {
    related: related.candidates,
    open: openCandidates,
    report: {
      related: related.report,
      open: { ...open.report, candidates: openCandidates.length },
    },
  };
}
