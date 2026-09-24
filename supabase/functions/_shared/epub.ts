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
};

export type EpubOptions = {
  name: string;
  displayDate: string;
  date: Date;
  timezone: string;
  label?: string;
  maxAssetBytes?: number;
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

export async function makeCoverPng(options: EpubOptions, articleCount: number) {
  const element = React.createElement;
  const monthLong = new Intl.DateTimeFormat("en-US", { timeZone: options.timezone, month: "long" }).format(options.date).toUpperCase();
  const day = datePart(options.date, options.timezone, "day");
  const year = datePart(options.date, options.timezone, "year");
  const titleSize = options.name.length <= 14 ? 132 : options.name.length <= 28 ? 108 : options.name.length <= 46 ? 84 : 68;
  const paper = "#ffffff", ink = "#000000";
  const cover = element("div", {
    style: {
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      background: paper, color: ink, fontFamily: "serif",
    },
  },
  element("div", {
    style: {
      display: "flex", alignItems: "center", justifyContent: "space-between",
      borderTop: `16px solid ${ink}`, borderBottom: `3px solid ${ink}`, padding: "35px 68px 31px",
      fontFamily: "monospace", textTransform: "uppercase",
    },
  },
  element("div", { style: { fontSize: 23, fontWeight: 900, letterSpacing: 4 } }, "MORNING READER"),
  element("div", {
    style: {
      background: ink, color: paper, padding: "10px 17px 9px",
      fontSize: 15, fontWeight: 800, letterSpacing: 2,
    },
  }, (options.label || "KINDLE EDITION").toUpperCase())),
  element("div", {
    style: { display: "flex", flexDirection: "column", padding: "54px 68px 48px", flex: 1 },
  },
  element("div", {
    style: {
      fontSize: titleSize, fontWeight: 700, lineHeight: 0.94, letterSpacing: -3,
      maxWidth: 1064, minHeight: 330, display: "flex", alignItems: "flex-start",
    },
  }, options.name),
  element("div", {
    style: {
      display: "flex", flexDirection: "column", background: ink,
      paddingRight: 16, paddingBottom: 16, marginTop: 24,
    },
  },
  element("div", {
    style: {
      display: "flex", flexDirection: "column", height: 540,
      background: paper, border: `5px solid ${ink}`,
    },
  },
  element("div", {
    style: {
      display: "flex", flex: 1, fontFamily: "monospace",
    },
  },
  element("div", {
    style: {
      display: "flex", flex: 1, alignItems: "center", justifyContent: "center",
      background: ink, color: paper, fontSize: 94, fontWeight: 900, letterSpacing: 4,
    },
  }, monthLong),
  element("div", {
    style: {
      width: 285, display: "flex", alignItems: "center", justifyContent: "center",
      borderLeft: `5px solid ${ink}`, fontSize: 122, fontWeight: 900, letterSpacing: -8,
      paddingRight: 12,
    },
  }, day)),
  element("div", {
    style: {
      height: 112, display: "flex", alignItems: "center", justifyContent: "space-between",
      borderTop: `4px solid ${ink}`, padding: "0 42px", fontFamily: "monospace",
      fontSize: 32, fontWeight: 900, letterSpacing: 4, textTransform: "uppercase",
    },
  },
  element("div", null, year),
  element("div", { style: { fontSize: 17, letterSpacing: 2 } }, `${articleCount} ${articleCount === 1 ? "article" : "articles"}`))))),
  element("div", {
    style: {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      borderTop: `3px solid ${ink}`, padding: "23px 68px 27px", fontFamily: "monospace",
      fontSize: 15, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase",
    },
  }, element("div", null, options.displayDate), element("div", { style: { textTransform: "none" } }, "reader.antonioskilton.com")));
  const response = new ImageResponse(cover, { width: 1200, height: 1600 });
  if (!response.ok) throw new Error("Could not render the cover image.");
  return new Uint8Array(await response.arrayBuffer());
}

export async function makeCoverJpeg(options: EpubOptions, articleCount: number) {
  // Decode only our fixed-size, opaque cover render, never publisher images.
  // This packaging was confirmed to produce a thumbnail in Kindle iOS.
  const png = await makeCoverPng(options, articleCount);
  const pixels = PNG.sync.read(Buffer.from(png));
  return new Uint8Array(jpeg.encode({ width: pixels.width, height: pixels.height, data: pixels.data }, 95).data);
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
  const cover = await makeCoverJpeg(options, articles.length);
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

  const css = `body{font-family:serif;line-height:1.55;margin:5%;color:#171717}h1{font-size:1.7em;line-height:1.12;margin-bottom:.3em}h2,h3,h4,h5,h6{line-height:1.2;margin:1.35em 0 .45em}.date,.source,.meta,.caption,figcaption{color:#595959;font-size:.88em}.meta{margin:.25em 0 1.5em}.article-nav{font-size:.78em;margin-bottom:1.4em}.article-nav a,.contents a,.section-divider a{color:#171717}a{color:#111}pre{white-space:pre-wrap;font-family:monospace;font-size:.86em;background:#f2f2f2;padding:.8em}code{font-family:monospace}blockquote{margin-left:.6em;border-left:2px solid #888;padding-left:1em}figure{margin:1.4em 0}img{display:block;max-width:100%;height:auto;margin:1em auto}figcaption{line-height:1.35;margin-top:.4em}table{border-collapse:collapse;width:100%;font-size:.82em;margin:1.2em 0}th,td{border:1px solid #888;padding:.38em;vertical-align:top}th{font-weight:bold}dl{margin:1em 0}dt{font-weight:bold;margin-top:.7em}dd{margin-left:1em}.contents{margin-top:1.4em}.publication-title{font-size:1.85em;margin-bottom:.12em}.contents-kicker{font-size:.74em;letter-spacing:.08em;text-transform:uppercase;color:#595959;margin:1.7em 0 .7em}.section-index-item{border-top:1px solid #777;padding:.7em 0 .8em}.section-index-item a{display:block;font-weight:bold;font-size:1.18em;text-decoration:none}.section-index-count{display:block;color:#595959;font-size:.82em;margin-top:.2em}.section-divider{padding-top:12%}.divider-rule{border-top:2px solid #111;margin:0 0 1.2em}.section-kicker{font-size:.72em;letter-spacing:.1em;text-transform:uppercase;color:#595959}.section-name{font-size:2.55em;line-height:1;margin:.2em 0 .2em}.section-count{font-size:.88em;color:#595959;margin-bottom:1.25em}.section-start{font-size:.88em;margin-top:1.15em}.topic-kicker{font-size:.78em;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;margin:0 0 1.1em}.original{margin-top:2em;padding-top:1em;border-top:1px solid #999;font-size:.85em}`;
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

  const machineNavItems = sectionPages.map(({ group, href }) => {
    const topics = group.topics.map((topic) => {
      const first = topic.items[0];
      const items = topic.items.map(({ article, index }) =>
        `<li><a href="article-${index + 1}.xhtml">${esc(article.title)}</a></li>`
      ).join("");
      if (!topic.name || !first) return items;
      return `<li><a href="article-${first.index + 1}.xhtml">${esc(topic.name)}</a><ol>${items}</ol></li>`;
    }).join("");
    const label = group.name || "Saved articles";
    return `<li><a href="${href}">${esc(label)}</a><ol>${topics}</ol></li>`;
  }).join("");
  output.file("nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(options.name)} navigation</title></head><body><nav epub:type="toc" id="toc"><h1>${esc(options.name)}</h1><ol>${machineNavItems}</ol></nav></body></html>`);

  const readerContents = sectionPages.map(({ group, href, articleCount }) => {
    const label = group.name || "Saved articles";
    return `<div class="section-index-item"><a href="${href}">${esc(label)}</a><span class="section-index-count">${articleCount} ${articleCount === 1 ? "story" : "stories"}</span></div>`;
  }).join("");
  output.file("contents.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(options.name)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><main class="contents"><p class="date">${esc(options.displayDate)}</p><h1 class="publication-title">${esc(options.name)}</h1><p class="contents-kicker">Sections</p>${readerContents}</main></body></html>`);

  for (const { group, href, articleCount, firstArticleIndex } of sectionPages) {
    const label = group.name || "Saved articles";
    const begin = firstArticleIndex === null ? "" : `<p class="section-start"><a href="article-${firstArticleIndex + 1}.xhtml">Begin section</a></p>`;
    output.file(href, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(label)} — ${esc(options.name)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body class="section-divider"><div class="divider-rule"></div><p class="section-kicker">${esc(options.name)} · ${esc(options.displayDate)}</p><h1 class="section-name">${esc(label)}</h1><p class="section-count">${articleCount} ${articleCount === 1 ? "story" : "stories"}</p><div class="divider-rule"></div>${begin}</body></html>`);
  }

  const manifest = [
    `<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
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

  const spine = [`<itemref idref="contents"/>`];
  const sectionHrefByArticleIndex = new Map<number, string>();
  const sectionNameByArticleIndex = new Map<number, string>();
  const topicNameByArticleIndex = new Map<number, string>();
  const topicStartIndices = new Set<number>();
  for (const section of sectionPages) {
    spine.push(`<itemref idref="${section.id}"/>`);
    const label = section.group.name || "Saved articles";
    for (const topic of section.group.topics) {
      const first = topic.items[0];
      if (first && topic.name) topicStartIndices.add(first.index);
      for (const { index } of topic.items) {
        spine.push(`<itemref idref="article-${index + 1}"/>`);
        sectionHrefByArticleIndex.set(index, section.href);
        sectionNameByArticleIndex.set(index, label);
        topicNameByArticleIndex.set(index, topic.name);
      }
    }
  }

  prepared.forEach((article, index) => {
    const id = `article-${index + 1}`;
    const date = article.published_at ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(article.published_at)) : "";
    const creator = article.author || article.source;
    const sectionHref = sectionHrefByArticleIndex.get(index) || "contents.xhtml";
    const sectionName = sectionNameByArticleIndex.get(index) || "Morning Reader";
    const topicName = topicNameByArticleIndex.get(index) || "";
    const topicKicker = topicStartIndices.has(index) && topicName
      ? `<p class="topic-kicker">${esc(topicName)}</p>`
      : "";
    output.file(`${id}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(article.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><p class="article-nav"><a href="${sectionHref}">${esc(sectionName)}</a> · <a href="contents.xhtml">Sections</a></p>${topicKicker}<h1>${esc(article.title)}</h1><p class="meta">${esc(creator)}${creator !== article.source ? ` · ${esc(article.source)}` : ""}${date ? ` · ${esc(date)}` : ""}</p>${article.body}<p class="original"><a href="${esc(article.canonical_url || article.url)}">Read the original article</a></p></body></html>`);
  });

  let assetIndex = 0;
  for (const asset of includedAssets.values()) {
    assetIndex++;
    output.file(asset.href, asset.bytes);
    manifest.push(`<item id="image-${assetIndex}" href="${esc(asset.href)}" media-type="${asset.mediaType}"/>`);
  }

  const bookId = crypto.randomUUID();
  let playOrder = 0;
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
    const label = section.group.name || "Saved articles";
    return `<navPoint id="nav-${sectionOrder}" playOrder="${sectionOrder}"><navLabel><text>${esc(label)}</text></navLabel><content src="${section.href}"/>${sectionChildren}</navPoint>`;
  }).join("");
  output.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${bookId}"/></head><docTitle><text>${esc(options.name)}</text></docTitle><navMap>${ncxSections}</navMap></ncx>`);
  output.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier><dc:title>${esc(options.name)} — ${esc(options.displayDate)}</dc:title><dc:language>en</dc:language><dc:creator>Morning Reader</dc:creator><meta name="cover" content="cover-image"/><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta><meta property="rendition:layout">reflowable</meta></metadata><manifest>${manifest.join("")}</manifest><spine toc="ncx">${spine.join("")}</spine></package>`);
  return await zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
