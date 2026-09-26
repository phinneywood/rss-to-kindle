import JSZip from "npm:jszip@3.10.1";
import { ImageResponse } from "npm:@vercel/og@0.6.8";
import React from "npm:react@19.1.1";
import { parseHTML } from "npm:linkedom@0.18.13";
import { Buffer } from "node:buffer";
// @deno-types="npm:@types/pngjs@6.0.5"
import { PNG } from "npm:pngjs@7.0.0";
import jpeg from "npm:jpeg-js@0.4.4";
import type { Article, ArticleAsset } from "./article.ts";

export type EpubArticle = Article & {
  feed_id?: string | null;
  section_id?: string | null;
  section_name?: string | null;
  pending_id?: string | null;
  editorial_topic?: string | null;
  editorial_topic_intro?: string | null;
  editorial_decision_reason?: string | null;
  editorial_position?: number | null;
  discovery_kind?: "related" | "open" | null;
  discovery_reason?: string | null;
};

export type EpubOptions = {
  name: string;
  displayDate: string;
  date: Date;
  timezone: string;
  label?: string;
  libraryTitle?: string;
  maxAssetBytes?: number;
  introduction?: string | null;
};

function esc(value: string) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function repairArticleAnchors(html: string): string {
  const document = (parseHTML(`<!doctype html><html><body>${html}</body></html>`) as any).document;
  const nodes = Array.from(document.querySelectorAll("[id]")) as any[];
  const reserved = new Set(nodes.map((node) => node.getAttribute("id")!));
  const replacements = new Map<string, string>();
  let counter = 0;
  let changed = false;
  for (const node of nodes) {
    const id = node.getAttribute("id")!;
    if (id && !/\s/.test(id)) continue;
    changed = true;
    if (!id) {
      node.removeAttribute("id");
      continue;
    }
    let replacement: string;
    do { replacement = `reader-anchor-${++counter}`; } while (reserved.has(replacement));
    reserved.add(replacement);
    node.setAttribute("id", replacement);
    if (!replacements.has(id)) replacements.set(id, replacement);
  }
  if (!changed) return html;
  for (const anchor of document.querySelectorAll('a[href^="#"]')) {
    const raw = anchor.getAttribute("href")!.slice(1);
    let target = raw;
    // A literal percent-encoded ID can be a real target; preserve it when present.
    if (!reserved.has(raw)) {
      try { target = decodeURIComponent(raw); } catch { /* Preserve malformed fragments. */ }
    }
    const replacement = replacements.get(target);
    if (replacement) anchor.setAttribute("href", `#${replacement}`);
  }
  return document.body.innerHTML;
}

function xmlBody(html: string) {
  return repairArticleAnchors(html)
    .replace(/<(br|hr)(\s*[^>]*)>/gi, (_match, tag, attrs) => `<${tag}${String(attrs).replace(/\/$/, "")} />`)
    .replace(/<img(\s[^>]*?)(?:\s*\/?)>/gi, (_match, attrs) => `<img${String(attrs).replace(/\/$/, "")} />`)
    .replace(/&nbsp;/gi, "&#160;")
    .replace(/&mdash;/gi, "&#8212;")
    .replace(/&ndash;/gi, "&#8211;")
    .replace(/&hellip;/gi, "&#8230;")
    .replace(/&lsquo;/gi, "&#8216;")
    .replace(/&rsquo;/gi, "&#8217;")
    .replace(/&ldquo;/gi, "&#8220;")
    .replace(/&rdquo;/gi, "&#8221;");
}

function datePart(date: Date, timezone: string, type: Intl.DateTimeFormatPartTypes) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).formatToParts(date);
  return parts.find((part) => part.type === type)?.value || "";
}

type CoverLine = { section: string; story: string };

function displaySectionName(value: string | null | undefined) {
  const name = String(value || "").trim();
  if (!name) return "Saved articles";
  if (/^other$/i.test(name)) return "Elsewhere";
  return name;
}

function sectionDeck(value: string | null | undefined) {
  const name = String(value || "").trim();
  if (name === "Related Discovery") return "Further reading on ideas running through this issue.";
  if (name === "Open Discovery") return "A deliberate detour.";
  return "";
}

function coverSectionName(value: string | null | undefined) {
  const name = displaySectionName(value);
  if (name === "Related Discovery") return "Further reading";
  if (name === "Open Discovery") return "A deliberate detour";
  return name;
}

function compactCoverText(value: string, max = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1).replace(/\s+\S*$/, "").trim();
  return (clipped || text.slice(0, max - 1)).trim() + "…";
}

function coverLinesFor(articles: EpubArticle[]): CoverLine[] {
  const groups = new Map<string, EpubArticle[]>();
  for (const article of articles) {
    const raw = String(article.section_name || "Other").trim() || "Other";
    if (!groups.has(raw)) groups.set(raw, []);
    groups.get(raw)!.push(article);
  }
  const primary = [...groups.entries()].filter(([name]) => name !== "Related Discovery" && name !== "Open Discovery" && !/^other$/i.test(name));
  const elsewhere = [...groups.entries()].filter(([name]) => /^other$/i.test(name));
  const discovery = [...groups.entries()].filter(([name]) => name === "Related Discovery" || name === "Open Discovery");
  return [...primary, ...elsewhere, ...discovery].slice(0, 3).map(([name, items]) => ({
    section: coverSectionName(name),
    story: compactCoverText(items[0]?.title || "", 92),
  }));
}

function coverSectionSize(value: string, lead = false) {
  const length = value.length;
  if (lead) return length > 34 ? 72 : length > 25 ? 82 : 94;
  return length > 34 ? 34 : length > 25 ? 39 : 44;
}

export async function makeCoverPng(options: EpubOptions, articleCount: number, coverLines: CoverLine[] = []) {
  const element = React.createElement;
  const monthLong = new Intl.DateTimeFormat("en-US", { timeZone: options.timezone, month: "long" }).format(options.date).toUpperCase();
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: options.timezone, weekday: "long" }).format(options.date).toUpperCase();
  const day = datePart(options.date, options.timezone, "day");
  const year = datePart(options.date, options.timezone, "year");
  const paper = "#ffffff", ink = "#080808", muted = "#5c5c5c";
  const lead = coverLines[0] || { section: "Morning reading", story: "A personal edition assembled for the day." };
  const secondary = coverLines.slice(1, 3);
  const label = (options.label || "DAILY EDITION").toUpperCase();

  const cover = element("div", {
    style: {
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      background: paper, color: ink, fontFamily: "serif", border: `10px solid ${ink}`,
      padding: "56px 62px 48px",
    },
  },
  element("div", {
    style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24 },
  },
  element("div", { style: { display: "flex", flexDirection: "column" } },
    element("div", {
      style: { fontFamily: "monospace", fontSize: 17, fontWeight: 800, letterSpacing: 4.2, textTransform: "uppercase" },
    }, "A PERSONAL DAILY READER"),
    element("div", {
      style: { fontSize: 118, fontWeight: 700, lineHeight: .88, letterSpacing: -5, marginTop: 18 },
    }, "Morning"),
    element("div", {
      style: { fontSize: 118, fontWeight: 700, lineHeight: .88, letterSpacing: -5 },
    }, "Reader")
  ),
  element("div", {
    style: {
      fontFamily: "monospace", fontSize: 14, fontWeight: 800, letterSpacing: 1.6,
      border: `2px solid ${ink}`, padding: "11px 13px 9px", textTransform: "uppercase",
    },
  }, label)),
  element("div", { style: { borderTop: `5px solid ${ink}`, marginTop: 38 } }),
  element("div", {
    style: {
      display: "flex", alignItems: "stretch", minHeight: 360,
      borderBottom: `2px solid ${ink}`,
    },
  },
  element("div", {
    style: {
      width: 390, display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 272, fontWeight: 700, lineHeight: .9, letterSpacing: -14, paddingRight: 22,
    },
  }, day),
  element("div", {
    style: {
      flex: 1, display: "flex", flexDirection: "column", justifyContent: "center",
      borderLeft: `2px solid ${ink}`, paddingLeft: 38,
    },
  },
  element("div", {
    style: { fontFamily: "monospace", fontSize: 18, fontWeight: 800, letterSpacing: 3.3, color: muted },
  }, weekday),
  element("div", {
    style: { fontSize: 58, fontWeight: 700, letterSpacing: -2, marginTop: 10 },
  }, monthLong),
  element("div", {
    style: { fontFamily: "monospace", fontSize: 25, fontWeight: 800, letterSpacing: 5, marginTop: 7 },
  }, year))),
  element("div", {
    style: {
      display: "flex", flexDirection: "column", background: ink, color: paper,
      marginTop: 38, padding: "40px 42px 42px", minHeight: 430,
    },
  },
  element("div", {
    style: { fontFamily: "monospace", fontSize: 16, fontWeight: 800, letterSpacing: 4, color: "#d6d6d6", textTransform: "uppercase" },
  }, "LEAD"),
  element("div", {
    style: {
      fontSize: coverSectionSize(lead.section, true), fontWeight: 700, lineHeight: .98,
      letterSpacing: -2.2, marginTop: 22, maxWidth: 980,
    },
  }, lead.section),
  lead.story ? element("div", {
    style: {
      fontFamily: "sans-serif", fontSize: 28, lineHeight: 1.24, marginTop: 28,
      color: "#e4e4e4", maxWidth: 980,
    },
  }, lead.story) : null),
  element("div", {
    style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "flex-start", marginTop: 26 },
  },
  ...secondary.map((line, index) => element("div", {
    key: `cover-line-${index}`,
    style: {
      display: "flex", gap: 26, borderTop: `2px solid ${ink}`,
      padding: "26px 0 28px", alignItems: "flex-start",
    },
  },
  element("div", {
    style: { width: 54, fontFamily: "monospace", fontSize: 16, fontWeight: 800, color: muted, paddingTop: 7 },
  }, String(index + 2).padStart(2, "0")),
  element("div", { style: { display: "flex", flexDirection: "column", flex: 1 } },
    element("div", {
      style: { fontSize: coverSectionSize(line.section), fontWeight: 700, lineHeight: 1.02, letterSpacing: -1.1 },
    }, line.section),
    line.story ? element("div", {
      style: { fontFamily: "sans-serif", fontSize: 22, lineHeight: 1.28, color: muted, marginTop: 9 },
    }, line.story) : null
  )))),
  element("div", {
    style: {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      borderTop: `5px solid ${ink}`, paddingTop: 22, fontFamily: "monospace",
      fontSize: 15, fontWeight: 800, letterSpacing: 1.7, textTransform: "uppercase",
    },
  },
  element("div", null, `${articleCount} ${articleCount === 1 ? "story" : "stories"}`),
  element("div", { style: { textTransform: "none", letterSpacing: .4 } }, "reader.antonioskilton.com")));

  const response = new ImageResponse(cover, { width: 1200, height: 1920 });
  if (!response.ok) throw new Error("Could not render the cover image.");
  return new Uint8Array(await response.arrayBuffer());
}

export async function makeCoverJpeg(options: EpubOptions, articleCount: number, coverLines: CoverLine[] = []) {
  const png = await makeCoverPng(options, articleCount, coverLines);
  const pixels = PNG.sync.read(Buffer.from(png));
  return new Uint8Array(jpeg.encode({ width: pixels.width, height: pixels.height, data: pixels.data }, 94).data);
}

function replaceOmittedImage(body: string, href: string) {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`<img\\b[^>]*src=["']${escaped}["'][^>]*\\/?>(?:</img>)?`, "gi"), "<p>[Image omitted to keep this edition compact.]</p>");
}

export async function makeEpub(options: EpubOptions, articles: EpubArticle[]) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.folder("META-INF")!.file("container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const output = zip.folder("OEBPS")!;
  const cover = await makeCoverJpeg(options, articles.length, coverLinesFor(articles));
  output.file("cover.jpg", cover);

  const maxAssetBytes = options.maxAssetBytes || 18_000_000;
  const includedAssets = new Map<string, ArticleAsset>();
  let assetBytes = 0;
  const prepared = articles.map((article) => {
    let body = article.body;
    for (const asset of article.assets || []) {
      if (includedAssets.has(asset.href)) continue;
      if (assetBytes + asset.bytes.byteLength > maxAssetBytes) {
        body = replaceOmittedImage(body, asset.href);
        continue;
      }
      includedAssets.set(asset.href, asset);
      assetBytes += asset.bytes.byteLength;
    }
    return { ...article, body: xmlBody(body) };
  });

  const css = `body{font-family:serif;line-height:1.55;margin:5%;color:#171717}h1{font-size:1.7em;line-height:1.12;margin-bottom:.3em}h2,h3,h4,h5,h6{line-height:1.2;margin:1.35em 0 .45em}.date,.source,.meta,.caption,figcaption{color:#595959;font-size:.88em}.meta{margin:.25em 0 1.15em}.article-rule{border:0;border-top:1px solid #aaa;margin:0 0 1.5em}a{color:#111}pre{white-space:pre-wrap;font-family:monospace;font-size:.86em;background:#f2f2f2;padding:.8em}code{font-family:monospace}blockquote{margin-left:.6em;border-left:2px solid #888;padding-left:1em}figure{margin:1.4em 0}img{display:block;max-width:100%;height:auto;margin:1em auto}figcaption{line-height:1.35;margin-top:.4em}table{border-collapse:collapse;width:100%;font-size:.82em;margin:1.2em 0}th,td{border:1px solid #888;padding:.38em;vertical-align:top}th{font-weight:bold}dl{margin:1em 0}dt{font-weight:bold;margin-top:.7em}dd{margin-left:1em}.contents{margin-top:.7em}.publication-title{font-size:1.75em;margin-bottom:.08em}.contents-kicker{font-family:sans-serif;font-size:.7em;font-weight:bold;letter-spacing:.09em;text-transform:uppercase;color:#595959;margin:1.25em 0 .55em}.section-index-item{border-top:1px solid #777;padding:.72em 0 .8em}.section-index-name{display:block;font-weight:bold;font-size:1.17em;line-height:1.15}.section-index-count{display:block;color:#666;font-family:sans-serif;font-size:.74em;margin-top:.12em}.contents-topic{margin-top:.45em}.contents-topic-name{font-family:sans-serif;font-size:.72em;font-weight:bold;letter-spacing:.035em;margin:.48em 0 .14em;color:#666}.contents-article{display:block;font-size:.84em;line-height:1.18;margin:.12em 0;color:#171717}.contents-article+.contents-article{margin-top:.16em}.section-divider{padding-top:8%}.divider-rule{border-top:2px solid #111;margin:0 0 1em}.section-kicker{font-family:sans-serif;font-size:.7em;font-weight:bold;letter-spacing:.1em;text-transform:uppercase;color:#595959}.section-name{font-size:2.55em;line-height:.98;margin:.18em 0 .16em;hyphens:none}.section-count{font-family:sans-serif;font-size:.82em;color:#595959;margin-bottom:.65em}.section-deck{font-size:1.02em;line-height:1.42;color:#555;margin:.35em 0 1.15em;max-width:28em}.introduction{padding-top:3%;max-width:32em}.intro-rule{border-top:2px solid #111;margin:0 0 .9em}.intro-kicker{font-family:sans-serif;font-size:.7em;font-weight:bold;letter-spacing:.11em;text-transform:uppercase;color:#595959;margin:.85em 0 0}.intro-copy{font-size:1.12em;line-height:1.5;margin:.95em 0 0}.original{margin-top:2em;padding-top:1em;border-top:1px solid #999;font-family:sans-serif;font-size:.78em;color:#666}.original a{color:#666;text-decoration:none}`;
  output.file("style.css", css);

  const navGroups: {
    name: string;
    topics: { name: string; items: { article: EpubArticle; index: number }[] }[];
  }[] = [];
  for (const [index, article] of prepared.entries()) {
    const sectionName = article.section_name || "";
    let group = navGroups.find((entry) => entry.name === sectionName);
    if (!group) { group = { name: sectionName, topics: [] }; navGroups.push(group); }
    const topicName = article.editorial_topic || "";
    let topic = group.topics.find((entry) => entry.name === topicName);
    if (!topic) {
      topic = { name: topicName, items: [] };
      group.topics.push(topic);
    }
    topic.items.push({ article, index });
  }

  const sectionPages = navGroups.map((group, groupIndex) => {
    const href = `section-${groupIndex + 1}.xhtml`;
    const articleCount = group.topics.reduce((count, topic) => count + topic.items.length, 0);
    const firstArticleIndex = group.topics.flatMap((topic) => topic.items)[0]?.index ?? null;
    return { group, href, articleCount, id: `section-${groupIndex + 1}`, firstArticleIndex };
  });

  const introduction = String(options.introduction || "").trim();
  if (introduction) {
    output.file("introduction.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Editor's note — ${esc(options.name)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><main class="introduction"><div class="intro-rule"></div><p class="date">${esc(options.displayDate)}</p><p class="intro-kicker">Editor's note</p><p class="intro-copy">${esc(introduction)}</p></main></body></html>`);
  }

  const machineNavItems = sectionPages.map(({ group, href }) => {
    const topics = group.topics.map((topic) => {
      const first = topic.items[0];
      const items = topic.items.map(({ article, index }) =>
        `<li><a href="article-${index + 1}.xhtml">${esc(article.title)}</a></li>`
      ).join("");
      if (!topic.name || !first) return items;
      return `<li><a href="article-${first.index + 1}.xhtml">${esc(topic.name)}</a><ol>${items}</ol></li>`;
    }).join("");
    const label = displaySectionName(group.name);
    return `<li><a href="${href}">${esc(label)}</a><ol>${topics}</ol></li>`;
  }).join("");
  const introductionNavItem = introduction ? '<li><a href="introduction.xhtml">Editor&#39;s note</a></li>' : "";
  output.file("nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(options.name)} navigation</title></head><body><nav epub:type="toc" id="toc"><h1>${esc(options.name)}</h1><ol>${introductionNavItem}${machineNavItems}</ol></nav></body></html>`);

  const readerContents = sectionPages.map(({ group, articleCount }) => {
    const label = displaySectionName(group.name);
    const topics = group.topics.map((topic) => {
      const topicLabel = topic.name ? `<h3 class="contents-topic-name">${esc(topic.name)}</h3>` : "";
      const articleLinks = topic.items.map(({ article }) =>
        `<span class="contents-article">${esc(article.title)}</span>`
      ).join("");
      return `<div class="contents-topic">${topicLabel}${articleLinks}</div>`;
    }).join("");
    return `<section class="section-index-item"><span class="section-index-name">${esc(label)}</span><span class="section-index-count">${articleCount} ${articleCount === 1 ? "story" : "stories"}</span>${topics}</section>`;
  }).join("");
  output.file("contents.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(options.name)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><main class="contents"><p class="date">${esc(options.displayDate)}</p><h1 class="publication-title">${esc(options.name)}</h1><p class="contents-kicker">In this issue</p>${readerContents}</main></body></html>`);

  for (const { group, href, articleCount } of sectionPages) {
    const label = displaySectionName(group.name);
    const deck = sectionDeck(group.name);
    const titleSize = label.length > 38 ? "1.72em" : label.length > 28 ? "2.02em" : label.length > 20 ? "2.28em" : "2.55em";
    output.file(href, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(label)} — ${esc(options.name)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body class="section-divider"><div class="divider-rule"></div><p class="section-kicker">${esc(options.name)} · ${esc(options.displayDate)}</p><h1 class="section-name" style="font-size:${titleSize}">${esc(label)}</h1><p class="section-count">${articleCount} ${articleCount === 1 ? "story" : "stories"}</p>${deck ? `<p class="section-deck">${esc(deck)}</p>` : ""}<div class="divider-rule"></div></body></html>`);
  }

  const manifest = [
    `<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ...(introduction ? [`<item id="introduction" href="introduction.xhtml" media-type="application/xhtml+xml"/>`] : []),
    `<item id="contents" href="contents.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ];
  for (const section of sectionPages) {
    manifest.push(`<item id="${section.id}" href="${section.href}" media-type="application/xhtml+xml"/>`);
  }
  prepared.forEach((article, index) => {
    const id = `article-${index + 1}`;
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
  });

  const spine = [
    ...(introduction ? [`<itemref idref="introduction"/>`] : []),
    `<itemref idref="contents"/>`,
  ];
  for (const section of sectionPages) {
    spine.push(`<itemref idref="${section.id}"/>`);
    for (const topic of section.group.topics) {
      for (const { index } of topic.items) {
        spine.push(`<itemref idref="article-${index + 1}"/>`);
      }
    }
  }

  prepared.forEach((article, index) => {
    const id = `article-${index + 1}`;
    const date = article.published_at ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(article.published_at)) : "";
    const creator = article.author || article.source;
    output.file(`${id}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(article.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>${esc(article.title)}</h1><p class="meta">${esc(creator)}${creator !== article.source ? ` · ${esc(article.source)}` : ""}${date ? ` · ${esc(date)}` : ""}</p><hr class="article-rule" />${article.body}<p class="original"><a href="${esc(article.canonical_url || article.url)}">Original source</a></p></body></html>`);
  });

  let assetIndex = 0;
  for (const asset of includedAssets.values()) {
    assetIndex++;
    output.file(asset.href, asset.bytes);
    manifest.push(`<item id="image-${assetIndex}" href="${esc(asset.href)}" media-type="${asset.mediaType}"/>`);
  }

  const bookId = crypto.randomUUID();
  let playOrder = 0;
  const ncxIntroduction = introduction
    ? `<navPoint id="nav-${++playOrder}" playOrder="${playOrder}"><navLabel><text>Editor's note</text></navLabel><content src="introduction.xhtml"/></navPoint>`
    : "";
  const ncxSections = sectionPages.map((section) => {
    const sectionOrder = ++playOrder;
    const sectionChildren = section.group.topics.map((topic) => {
      if (!topic.items.length) return "";
      if (!topic.name) {
        return topic.items.map(({ article, index }) => {
          const articleOrder = ++playOrder;
          return `<navPoint id="nav-${articleOrder}" playOrder="${articleOrder}"><navLabel><text>${esc(article.title)}</text></navLabel><content src="article-${index + 1}.xhtml"/></navPoint>`;
        }).join("");
      }
      const topicOrder = ++playOrder;
      const articleChildren = topic.items.map(({ article, index }) => {
        const articleOrder = ++playOrder;
        return `<navPoint id="nav-${articleOrder}" playOrder="${articleOrder}"><navLabel><text>${esc(article.title)}</text></navLabel><content src="article-${index + 1}.xhtml"/></navPoint>`;
      }).join("");
      return `<navPoint id="nav-${topicOrder}" playOrder="${topicOrder}"><navLabel><text>${esc(topic.name)}</text></navLabel><content src="article-${topic.items[0].index + 1}.xhtml"/>${articleChildren}</navPoint>`;
    }).join("");
    const label = displaySectionName(section.group.name);
    return `<navPoint id="nav-${sectionOrder}" playOrder="${sectionOrder}"><navLabel><text>${esc(label)}</text></navLabel><content src="${section.href}"/>${sectionChildren}</navPoint>`;
  }).join("");
  output.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${bookId}"/></head><docTitle><text>${esc(options.name)}</text></docTitle><navMap>${ncxIntroduction}${ncxSections}</navMap></ncx>`);
  output.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier><dc:title>${esc(options.libraryTitle || `${options.name} — ${options.displayDate}`)}</dc:title><dc:language>en</dc:language><dc:creator>Morning Reader</dc:creator><meta name="cover" content="cover-image"/><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta><meta property="rendition:layout">reflowable</meta></metadata><manifest>${manifest.join("")}</manifest><spine toc="ncx">${spine.join("")}</spine></package>`);
  return await zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export type EpubQaReport = {
  articles: number;
  contentsEntries: number;
  packagedImages: number;
};

export async function validateEpub(bytes: Uint8Array, articles: EpubArticle[], introduction?: string | null): Promise<EpubQaReport> {
  const zip = await JSZip.loadAsync(bytes);
  const contents = await zip.file("OEBPS/contents.xhtml")?.async("string");
  const nav = await zip.file("OEBPS/nav.xhtml")?.async("string");
  const opf = await zip.file("OEBPS/content.opf")?.async("string");
  if (!contents || !nav || !opf) throw new Error("EPUB QA failed: required navigation files are missing.");

  const expectedIntroduction = String(introduction || "").trim();
  if (expectedIntroduction) {
    const introPage = await zip.file("OEBPS/introduction.xhtml")?.async("string");
    if (!introPage) throw new Error("EPUB QA failed: issue introduction page is missing.");
    if (!introPage.includes(`<p class="intro-copy">${esc(expectedIntroduction)}</p>`)) {
      throw new Error("EPUB QA failed: issue introduction text does not match the frozen manifest.");
    }
    if (!opf.includes('id="introduction" href="introduction.xhtml"')) {
      throw new Error("EPUB QA failed: issue introduction is missing from the manifest.");
    }
    const introSpine = opf.indexOf('<itemref idref="introduction"/>');
    const contentsSpine = opf.indexOf('<itemref idref="contents"/>');
    if (introSpine < 0 || contentsSpine < 0 || introSpine > contentsSpine) {
      throw new Error("EPUB QA failed: issue introduction is not the first reading page.");
    }
    if (!nav.includes('href="introduction.xhtml">Editor&#39;s note</a>')) {
      throw new Error("EPUB QA failed: native navigation is missing the issue introduction.");
    }
  }

  let contentsEntries = 0;
  for (const [index, article] of articles.entries()) {
    const href = `article-${index + 1}.xhtml`;
    const page = await zip.file(`OEBPS/${href}`)?.async("string");
    if (!page) throw new Error(`EPUB QA failed: missing article page ${index + 1}.`);
    const visibleTitle = `<span class="contents-article">${esc(article.title)}</span>`;
    const titleLink = `href="${href}">${esc(article.title)}</a>`;
    if (!contents.includes(visibleTitle)) throw new Error(`EPUB QA failed: contents page is missing article ${index + 1}.`);
    if (!nav.includes(titleLink)) throw new Error(`EPUB QA failed: native navigation is missing article ${index + 1}.`);
    contentsEntries++;

    const imageRefs = [...page.matchAll(/src=["'](images\/[^"']+)["']/g)].map((match) => match[1]);
    for (const imageRef of imageRefs) {
      if (!zip.file(`OEBPS/${imageRef}`)) {
        throw new Error(`EPUB QA failed: article ${index + 1} references a missing image asset.`);
      }
      if (!opf.includes(`href="${esc(imageRef)}"`)) {
        throw new Error(`EPUB QA failed: article ${index + 1} image is missing from the manifest.`);
      }
    }
  }

  const packagedImages = Object.keys(zip.files).filter((name) => /^OEBPS\/images\//.test(name) && !zip.files[name].dir).length;
  return { articles: articles.length, contentsEntries, packagedImages };
}
