import { Readability } from "npm:@mozilla/readability@0.6.0";
import { parseHTML } from "npm:linkedom@0.18.13";
import sanitizeHtml from "npm:sanitize-html@2.17.7";
import { XMLParser } from "npm:fast-xml-parser@5.11.1";
import { ImageMagick, initializeImageMagick, MagickFormat } from "npm:@imagemagick/magick-wasm@0.0.43";
import { fetchPublic } from "./network.ts";
export { fetchPublicText } from "./network.ts";

export type ExtractionBudget = { imageBytes: number; deadline: number };
export function extractionBudget(deadline = Infinity): ExtractionBudget { return { imageBytes: 6_000_000, deadline: Math.min(Date.now() + 80_000, deadline) }; }

export type ArticleAsset = {
  href: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif";
  bytes: Uint8Array;
  sourceUrl: string;
};

export type ArticleMediaDiagnostics = {
  discovered: number;
  embedded: number;
  failed: number;
  omitted: number;
  failures: Array<{ url: string; reason: string }>;
};

export type Article = {
  title: string;
  url: string;
  canonical_url: string;
  source: string;
  author: string | null;
  published_at: string | null;
  excerpt: string;
  body: string;
  assets: ArticleAsset[];
  warnings: string[];
  media?: ArticleMediaDiagnostics;
  article_hash: string;
};

export type ExtractArticleInput = {
  url: string;
  title?: string;
  source?: string;
  author?: string | null;
  publishedAt?: string | null;
  feedHtml?: string;
  feedKind?: "full" | "summary";
  includeImages?: boolean;
  budget?: ExtractionBudget;
};

const ARTICLE_TAGS = [
  "p", "br", "div", "section", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "code", "ul", "ol", "li", "strong", "b", "em", "i",
  "a", "hr", "sup", "sub", "figure", "figcaption", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td", "dl", "dt", "dd", "img",
];

const BLOCKED_SELECTORS = [
  "script", "style", "noscript", "nav", "aside", "footer", "header", "form",
  "button", "input", "select", "textarea", "canvas", "svg",
];

export function textValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("__cdata" in record) return textValue(record.__cdata);
    if ("#text" in record) return textValue(record["#text"]);
  }
  return "";
}

export function plainText(html: string): string {
  return sanitizeHtml((html || "").replace(/<[^>]+>/g, " "), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function resolveHttpUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function recoverEmbeddedImageUrl(value: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(/https?%3A%2F%2F[^?#\s"'<>]+/i);
  if (!match) return raw;
  try {
    const decoded = decodeURIComponent(match[0]);
    const url = new URL(decoded);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : raw;
  } catch {
    return raw;
  }
}

export function resolveLinkPostTarget(feedHtml: string | undefined, requestedUrl: string): { url: string; isLinkPostWrapper: boolean } {
  const raw = feedHtml || "";
  const text = plainText(raw);
  const isLinkPostWrapper = /\bArticle\s+URL\s*:/i.test(text) && /\bComments\s+URL\s*:/i.test(text);
  if (!isLinkPostWrapper) return { url: requestedUrl, isLinkPostWrapper: false };

  const hrefMatch = raw.match(/Article\s+URL\s*:\s*(?:<[^>]+>\s*)*<a\b[^>]*href=["']([^"']+)["']/i);
  const textMatch = text.match(/Article\s+URL\s*:\s*(https?:\/\/\S+)/i);
  const rawCandidate = String(hrefMatch?.[1] || textMatch?.[1] || "")
    .replace(/&amp;/gi, "&")
    .replace(/[),.;]+$/, "");
  const resolved = rawCandidate ? resolveHttpUrl(rawCandidate, requestedUrl) : "";
  return { url: resolved || requestedUrl, isLinkPostWrapper: true };
}

function imageCandidate(element: any): string {
  const direct = element.getAttribute("data-src") || element.getAttribute("data-original") || element.getAttribute("data-lazy-src") || element.getAttribute("src") || "";
  const picture = element.closest("picture");
  const pictureSources = picture ? Array.from(picture.querySelectorAll("source[srcset]")) as any[] : [];
  const fallback = pictureSources.find((source) => {
    const type = String(source.getAttribute("type") || "").toLowerCase();
    const srcset = String(source.getAttribute("srcset") || "");
    return ["image/jpeg", "image/png", "image/gif"].includes(type) ||
      (!type && !/\.(?:webp|avif)(?:[?#]|\s|$)/i.test(srcset));
  });
  const srcset = fallback?.getAttribute("srcset") || element.getAttribute("data-srcset") || element.getAttribute("srcset") || "";
  if (!srcset) return direct;
  const candidates = srcset.split(",").map((part: string) => {
    const [url, descriptor = ""] = part.trim().split(/\s+/, 2);
    const score = descriptor.endsWith("w") ? Number(descriptor.slice(0, -1)) : descriptor.endsWith("x") ? Number(descriptor.slice(0, -1)) * 1000 : 0;
    return { url, score: Number.isFinite(score) ? score : 0 };
  }).filter((x: { url: string }) => x.url);
  candidates.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  return candidates[0]?.url || direct;
}

function normalizeDom(document: any, baseUrl: string) {
  for (const selector of BLOCKED_SELECTORS) {
    for (const node of Array.from(document.querySelectorAll(selector)) as any[]) node.remove();
  }
  for (const node of Array.from(document.querySelectorAll("iframe,video,audio")) as any[]) {
    const raw = node.getAttribute("src") || node.querySelector?.("source")?.getAttribute("src") || "";
    const href = resolveHttpUrl(raw, baseUrl);
    if (!href) {
      node.remove();
      continue;
    }
    const paragraph = document.createElement("p");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.textContent = "View embedded media";
    paragraph.appendChild(anchor);
    node.replaceWith(paragraph);
  }
  for (const anchor of Array.from(document.querySelectorAll("a[href]")) as any[]) {
    const href = String(anchor.getAttribute("href") || "").trim();
    if (href.startsWith("#")) continue;
    const resolved = resolveHttpUrl(href, baseUrl);
    if (resolved) anchor.setAttribute("href", resolved);
    else anchor.removeAttribute("href");
  }
  for (const image of Array.from(document.querySelectorAll("img")) as any[]) {
    const width = Number(image.getAttribute("width") || 0);
    const height = Number(image.getAttribute("height") || 0);
    if (!image.getAttribute("data-src") && !image.getAttribute("data-original") && ((width > 0 && width <= 32) || (height > 0 && height <= 32))) {
      image.remove();
      continue;
    }
    const resolved = resolveHttpUrl(recoverEmbeddedImageUrl(imageCandidate(image)), baseUrl);
    if (!resolved) {
      image.remove();
      continue;
    }
    image.setAttribute("src", resolved);
    if (image.getAttribute("data-src") || image.getAttribute("data-original")) {
      image.removeAttribute("width");image.removeAttribute("height");
    }
    image.removeAttribute("srcset");
    image.removeAttribute("sizes");
    image.removeAttribute("loading");
  }
}

export function sanitizeArticleHtml(input: string, baseUrl: string): string {
  const document = (parseHTML(`<!doctype html><html><body>${input || ""}</body></html>`) as any).document;
  normalizeDom(document, baseUrl);
  return sanitizeHtml(document.body.innerHTML, {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: {
      "*": ["id"],
      a: ["href", "title", "name"],
      img: ["src", "alt", "title", "width", "height"],
      ol: ["start"],
      li: ["value"],
      th: ["colspan", "rowspan", "scope"],
      td: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      h1: "h2",
      picture: "figure",
    },
  }).replace(/<p>\s*<\/p>/g, "").trim();
}

function normalizeTitle(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function stripDuplicateTitle(html: string, title: string) {
  const normalizedTitle = plainText(title).toLowerCase();
  if (!normalizedTitle) return html;
  let removed = false;
  return html.replace(/<(h[2-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi, (full, _tag, inner, offset) => {
    if (removed || offset > 2500) return full;
    const candidate = plainText(inner).toLowerCase();
    const close = candidate === normalizedTitle ||
      (candidate.length > 12 && normalizedTitle.length > 12 &&
        (candidate.startsWith(normalizedTitle) || normalizedTitle.startsWith(candidate)) &&
        Math.abs(candidate.length - normalizedTitle.length) < 12);
    if (!close) return full;
    removed = true;
    return "";
  }).trim();
}

function meta(document: any, selectors: string[]): string {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const value = node?.getAttribute("content") || node?.getAttribute("datetime") || node?.textContent || "";
    if (String(value).trim()) return String(value).trim();
  }
  return "";
}

function structuredMetadata(document: any) {
  const nodes: any[] = [];
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')) as any[]) {
    try {
      const value = JSON.parse(String(script.textContent || ""));
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        if (Array.isArray(item?.["@graph"])) nodes.push(...item["@graph"]);
        else if (item && typeof item === "object") nodes.push(item);
      }
    } catch {
      // Invalid publisher metadata should not prevent article extraction.
    }
  }
  const types = (node: any): string[] => (Array.isArray(node?.["@type"]) ? node["@type"] : [node?.["@type"]]).filter(Boolean).map(String);
  const page = nodes.find((node) => types(node).some((type: string) => ["Article", "NewsArticle", "BlogPosting", "Report", "WebPage"].includes(type))) || {};
  const website = nodes.find((node) => types(node).includes("WebSite")) || {};
  const resolveName = (value: any): string => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(resolveName).filter(Boolean).join(" & ");
    if (value.name) return String(value.name);
    if (value["@id"]) return resolveName(nodes.find((node) => node?.["@id"] === value["@id"]));
    return "";
  };
  return {
    title: String(page.headline || page.name || ""),
    author: resolveName(page.author),
    publishedAt: String(page.datePublished || ""),
    source: String(website.name || page.publisher?.name || ""),
    excerpt: String(page.description || ""),
  };
}

function visibleAuthors(document: any): string {
  const selectors = [
    'a[rel="author"]',
    '[itemprop="author"] [itemprop="name"]',
    '.author.vcard .fn',
    '.entry-meta .author',
    '.author-section .author-wrapper strong',
  ];
  const names: string[] = [];
  for (const selector of selectors) {
    for (const node of Array.from(document.querySelectorAll(selector)) as any[]) {
      const name = normalizeTitle(String(node.textContent || ""));
      if (name && name.length <= 100 && !names.includes(name)) names.push(name);
    }
    if (names.length) break;
  }
  return names.slice(0, 6).join(" & ");
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(+date) ? null : date.toISOString();
}

function arrayValue<T = any>(value: T | T[] | null | undefined): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function feedLink(value: any): string {
  if (typeof value === "string") return value;
  for (const candidate of arrayValue(value)) {
    if (typeof candidate === "string") return candidate;
    if (candidate && typeof candidate === "object" && candidate["@_href"] && (!candidate["@_rel"] || candidate["@_rel"] === "alternate")) {
      return String(candidate["@_href"]);
    }
  }
  return "";
}

export function extractMediumFeedArticle(feedXml: string, requestedUrl: string): ReturnType<typeof extractArticleDocument> | null {
  const requested = new URL(requestedUrl);
  if (!requested.hostname.toLowerCase().endsWith(".medium.com")) return null;
  const articleId = requested.pathname.match(/-([0-9a-f]{10,16})\/?$/i)?.[1]?.toLowerCase();
  if (!articleId) return null;

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "__cdata" });
  const parsed: any = parser.parse(feedXml);
  const channel = parsed?.rss?.channel;
  const entries = arrayValue(channel?.item);
  const item = entries.find((entry: any) => {
    const candidates = [feedLink(entry?.link), textValue(entry?.guid), textValue(entry?.id)].filter(Boolean);
    return candidates.some((candidate) => candidate.toLowerCase().includes(articleId));
  });
  if (!item) return null;

  const rawCanonical = feedLink(item.link) || textValue(item.guid) || requestedUrl;
  let canonicalUrl = resolveHttpUrl(rawCanonical, requestedUrl) || requestedUrl;
  try {
    const canonical = new URL(canonicalUrl);
    canonical.search = "";
    canonical.hash = "";
    canonicalUrl = canonical.toString();
  } catch {
    canonicalUrl = requestedUrl;
  }

  const rawBody = textValue(item["content:encoded"] ?? item.content ?? item.description ?? item.summary ?? "");
  const html = sanitizeArticleHtml(rawBody, canonicalUrl);
  if (plainText(html).length < 180) return null;

  const title = normalizeTitle(textValue(item.title) || "Untitled") || "Untitled";
  const author = normalizeTitle(textValue(item["dc:creator"] || item.author?.name || item.author || "")) || null;
  const source = normalizeTitle(textValue(channel?.title) || requested.hostname.replace(/^www\./, ""));
  const publishedAt = isoDate(textValue(item.pubDate || item.published || item.updated || item["dc:date"]));
  const excerptSource = textValue(item.description || item.summary || rawBody);

  return {
    title,
    author,
    source,
    publishedAt,
    excerpt: plainText(excerptSource).slice(0, 320),
    canonicalUrl,
    html,
  };
}

async function fetchMediumFeedArticle(requestedUrl: string, budget: ExtractionBudget) {
  const url = new URL(requestedUrl);
  if (!url.hostname.toLowerCase().endsWith(".medium.com")) return null;
  const feedUrl = new URL("/feed/", url.origin).toString();
  const fetched = await fetchPublic(feedUrl, {
    accept: "application/rss+xml,application/xml,text/xml,*/*",
    maxBytes: 2_000_000,
    deadline: budget.deadline,
  });
  return extractMediumFeedArticle(new TextDecoder().decode(fetched.bytes), requestedUrl);
}

export function extractArticleDocument(pageHtml: string, pageUrl: string) {
  const document = (parseHTML(pageHtml) as any).document;
  const canonicalRaw = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || pageUrl;
  const canonicalUrl = resolveHttpUrl(canonicalRaw, pageUrl) || pageUrl;
  const structured = structuredMetadata(document);
  const source = meta(document, ['meta[property="og:site_name"]', 'meta[name="application-name"]']) || structured.source;
  const publishedAt = meta(document, [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
    "time[datetime]",
  ]) || structured.publishedAt;
  const author = meta(document, ['meta[name="author"]', 'meta[property="article:author"]']) || visibleAuthors(document) || structured.author;
  const title = meta(document, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) || structured.title;
  const excerpt = meta(document, ['meta[name="description"]', 'meta[property="og:description"]']) || structured.excerpt;
  const reader = new Readability(document as any, { charThreshold: 180 });
  const parsed = reader.parse();
  if (!parsed?.content || plainText(parsed.content).length < 180) throw new Error("Morning Reader could not identify the main article text.");
  const finalSource = normalizeTitle(parsed.siteName || source);
  let finalTitle = normalizeTitle(title || parsed.title || document.title || "Untitled");
  if (finalSource) {
    const escapedSource = finalSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    finalTitle = finalTitle.replace(new RegExp(`\\s*[|—–-]\\s*${escapedSource}$`, "i"), "").trim() || finalTitle;
  }
  return {
    title: finalTitle,
    author: normalizeTitle(author || (/about (?:the )?author/i.test(parsed.byline || "") ? "" : parsed.byline || "")) || null,
    source: finalSource,
    publishedAt: isoDate(publishedAt),
    excerpt: plainText(excerpt || parsed.excerpt || "").slice(0, 320),
    canonicalUrl,
    html: sanitizeArticleHtml(parsed.content, pageUrl),
  };
}

function replaceImageWithNote(document: any, image: any) {
  const alt = String(image.getAttribute("alt") || "").trim();
  if (!alt) {
    image.remove();
    return;
  }
  const note = document.createElement("p");
  note.textContent = `[Image: ${alt}]`;
  image.replaceWith(note);
}

function detectedImage(bytes: Uint8Array): { mediaType: ArticleAsset["mediaType"]; extension: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return { mediaType: "image/png", extension: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mediaType: "image/jpeg", extension: "jpg" };
  const signature = new TextDecoder().decode(bytes.subarray(0, 6));
  if (signature === "GIF87a" || signature === "GIF89a") return { mediaType: "image/gif", extension: "gif" };
  return null;
}

function isWebp(bytes: Uint8Array) {
  return bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
}

let imageMagickReady: Promise<void> | null = null;
async function ensureImageMagick() {
  if (!imageMagickReady) {
    imageMagickReady = (async () => {
      const packageEntry = new URL(import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.43"));
      const wasmUrl = new URL("x86/magick.wasm", packageEntry);
      const wasmBytes = await Deno.readFile(wasmUrl);
      await initializeImageMagick(wasmBytes);
    })();
  }
  await imageMagickReady;
}

async function decodeSupportedImage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mediaType: ArticleAsset["mediaType"]; extension: string }> {
  const detected = detectedImage(bytes);
  if (detected) return { bytes, ...detected };
  if (!isWebp(bytes)) throw new Error("unsupported image format");

  await ensureImageMagick();
  const outputs: Uint8Array[] = [];
  await ImageMagick.read(bytes, async image => {
    await image.write(MagickFormat.Png, data => {
      outputs.push(Uint8Array.from(data));
    });
  });
  const png = outputs[0];
  if (!png || png.length === 0) throw new Error("WebP transcoding returned no image data");
  return { bytes: png, mediaType: "image/png", extension: "png" };
}

async function embedImages(html: string, baseUrl: string, budget: ExtractionBudget): Promise<{ html: string; assets: ArticleAsset[]; warnings: string[]; media: ArticleMediaDiagnostics }> {
  const document = (parseHTML(`<!doctype html><html><body>${html}</body></html>`) as any).document;
  const images = Array.from(document.querySelectorAll("img[src]")) as any[];
  const assets: ArticleAsset[] = [];
  const warnings: string[] = [];
  const failures: ArticleMediaDiagnostics["failures"] = [];
  let embeddedCount = 0;
  let failedCount = 0;
  let omittedCount = 0;
  const byUrl = new Map<string, any[]>();
  for (const image of images) {
    const sourceUrl = String(image.getAttribute("src") || "");
    if (!sourceUrl) continue;
    const group = byUrl.get(sourceUrl) || [];
    group.push(image);byUrl.set(sourceUrl, group);
  }
  const urls = [...byUrl.keys()];
  const fetched = new Map<string, { bytes: Uint8Array; mediaType: ArticleAsset["mediaType"]; extension: string } | Error>();
  let cursor = 0;
  async function imageWorker() {
    while (true) {
      const index = cursor++;if (index >= Math.min(8, urls.length)) return;
      const sourceUrl = urls[index];
      try {
        if (budget.imageBytes <= 0 || Date.now() >= budget.deadline) throw new Error("image budget exceeded");
        const reservation = Math.min(1_500_000, budget.imageBytes);
        budget.imageBytes -= reservation;
        let received = 0;
        try {
        const result = await fetchPublic(sourceUrl, {
          accept: "image/jpeg,image/png,image/gif;q=0.9",
          maxBytes: reservation,
          timeoutMs: 8_000,
          deadline: budget.deadline,
        });
        const image = await decodeSupportedImage(result.bytes);
        received = result.bytes.length;
        fetched.set(sourceUrl, image);
        } finally { budget.imageBytes += reservation - received; }
      } catch (error) {
        fetched.set(sourceUrl, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, urls.length, 8) }, () => imageWorker()));
  let totalBytes = 0;
  for (const [index, sourceUrl] of urls.entries()) {
    const group = byUrl.get(sourceUrl) || [];
    const result = fetched.get(sourceUrl);
    if (index >= 8) {
      const reason = "article image count limit exceeded";
      omittedCount += group.length;
      failures.push({ url: sourceUrl, reason });
      warnings.push(`Image omitted (${reason}): ${sourceUrl}`);
      for (const image of group) replaceImageWithNote(document, image);
      continue;
    }
    if (!result || result instanceof Error) {
      const reason = result instanceof Error ? result.message : "image fetch returned no result";
      failedCount += group.length;
      failures.push({ url: sourceUrl, reason });
      warnings.push(`Image omitted (${reason}): ${sourceUrl}`);
      for (const image of group) replaceImageWithNote(document, image);
      continue;
    }
    if (totalBytes + result.bytes.byteLength > 8_000_000) {
      const reason = "article image byte budget exceeded";
      omittedCount += group.length;
      failures.push({ url: sourceUrl, reason });
      warnings.push(`Image omitted (${reason}): ${sourceUrl}`);
      for (const image of group) replaceImageWithNote(document, image);
      continue;
    }
    const digest = (await sha256(sourceUrl)).slice(0, 20);
    const asset: ArticleAsset = { href: `images/${digest}.${result.extension}`, mediaType: result.mediaType, bytes: result.bytes, sourceUrl };
    assets.push(asset);totalBytes += result.bytes.byteLength;
    embeddedCount += group.length;
    for (const image of group) image.setAttribute("src", asset.href);
  }
  return {
    html: document.body.innerHTML,
    assets,
    warnings: [...new Set(warnings)],
    media: {
      discovered: images.length,
      embedded: embeddedCount,
      failed: failedCount,
      omitted: omittedCount,
      failures,
    },
  };
}

export async function hydrateArticleImages(article: Article, budget: ExtractionBudget): Promise<Article> {
  if (article.assets?.length) return article;
  const embedded = await embedImages(article.body, article.canonical_url || article.url, budget);
  return {
    ...article,
    body: embedded.html,
    assets: embedded.assets,
    warnings: [...new Set([...(article.warnings || []), ...embedded.warnings])],
    media: embedded.media,
  };
}

export function omitArticleImages(article: Article): Article {
  let discovered = 0;
  const body = article.body.replace(/<img\b[^>]*>/gi, () => {
    discovered++;
    return "<p>[Image omitted in test edition.]</p>";
  });
  return {
    ...article,
    body,
    assets: [],
    media: { discovered, embedded: 0, failed: 0, omitted: discovered, failures: [] },
  };
}

export async function extractArticle(input: ExtractArticleInput): Promise<Article> {
  const budget = input.budget || extractionBudget();
  if (Date.now() >= budget.deadline) throw new Error("Article preparation time limit reached.");
  const inputUrl = new URL(input.url).toString();
  const linkPost = resolveLinkPostTarget(input.feedHtml, inputUrl);
  const requestedUrl = linkPost.url;
  const warnings: string[] = [];
  let page: ReturnType<typeof extractArticleDocument> | null = null;
  let finalUrl = requestedUrl;
  let pageError: Error | null = null;

  // Link-post feed descriptions (for example HNRSS) are discovery metadata,
  // not article content. Never package those wrappers as a fallback reading copy.
  const feedBody = linkPost.isLinkPostWrapper
    ? ""
    : input.feedHtml
    ? sanitizeArticleHtml(input.feedHtml, requestedUrl)
    : "";
  const feedLength = plainText(feedBody).length;
  const shouldFetchPage = linkPost.isLinkPostWrapper || !feedBody || input.feedKind !== "full" || feedLength < 400;
  if (shouldFetchPage) {
    try {
      const fetched = await fetchPublic(requestedUrl, { accept: "text/html,application/xhtml+xml", maxBytes: 2_000_000, deadline: budget.deadline });
      finalUrl = fetched.url;
      page = extractArticleDocument(new TextDecoder().decode(fetched.bytes), fetched.url);
    } catch (error) {
      pageError = error instanceof Error ? error : new Error(String(error));
      if (!feedBody) {
        try {
          const fallback = await fetchMediumFeedArticle(requestedUrl, budget);
          if (fallback) {
            page = fallback;
            finalUrl = fallback.canonicalUrl;
            pageError = null;
            warnings.push("The publisher page was unavailable, so Morning Reader used the publication feed.");
          }
        } catch {
          // Preserve the original publisher-page error if the fallback is unavailable.
        }
      }
    }
  }

  let body = feedBody;
  if (page && (!feedBody || input.feedKind !== "full") && plainText(page.html).length >= Math.max(180, feedLength * 0.72)) {
    body = page.html;
  }
  if (!body && page) body = page.html;
  if (!body || plainText(body).length < 80) throw pageError || new Error("Morning Reader could not extract enough article text.");
  if (body.length > 250_000) throw new Error("This article is too large to prepare safely. Open the original article instead.");
  if (pageError && feedBody) warnings.push("The publisher page was unavailable, so Morning Reader used the feed version.");

  const title = normalizeTitle(page?.title || input.title || "Untitled") || "Untitled";
  body = stripDuplicateTitle(body, title);
  const canonicalUrl = page?.canonicalUrl || finalUrl;
  // Publisher-page metadata is authoritative when we fetched the linked article.
  // Feed metadata describes how Morning Reader discovered the article and may name
  // the curator/reposter rather than the actual author or publication.
  const source = normalizeTitle(page?.source || input.source || new URL(canonicalUrl).hostname.replace(/^www\./, ""));
  const author = normalizeTitle(page?.author || input.author || "") || null;
  const publishedAt = page?.publishedAt || isoDate(input.publishedAt) || null;
  const excerpt = (page?.excerpt || plainText(body)).slice(0, 320);
  let assets: ArticleAsset[] = [];
  if (input.includeImages !== false) {
    const embedded = await embedImages(body, canonicalUrl, budget);
    body = embedded.html;
    assets = embedded.assets;
    warnings.push(...embedded.warnings);
    return {
      title,
      url: requestedUrl,
      canonical_url: canonicalUrl,
      source,
      author,
      published_at: publishedAt,
      excerpt,
      body,
      assets,
      warnings: [...new Set(warnings)],
      media: embedded.media,
      article_hash: await sha256(canonicalUrl),
    };
  }
  return {
    title,
    url: requestedUrl,
    canonical_url: canonicalUrl,
    source,
    author,
    published_at: publishedAt,
    excerpt,
    body,
    assets,
    warnings: [...new Set(warnings)],
    article_hash: await sha256(canonicalUrl),
  };
}
