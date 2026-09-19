import JSZip from "npm:jszip@3.10.1";
import { ImageResponse } from "npm:@vercel/og@0.6.8";
import React from "npm:react@19.1.1";
import { parseHTML } from "npm:linkedom@0.18.13";
import type { Article, ArticleAsset } from "./article.ts";

export type EpubArticle = Article & {
  feed_id?: string | null;
  section_id?: string | null;
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
  const cover = await makeCoverPng(options, articles.length);
  output.file("cover.png", cover);

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

  const css = `body{font-family:serif;line-height:1.55;margin:5%;color:#171717}h1{font-size:1.7em;line-height:1.12;margin-bottom:.25em}h2,h3,h4,h5,h6{line-height:1.2;margin:1.4em 0 .45em}.date,.source,.meta,.caption,figcaption{color:#595959;font-size:.88em}.source{display:block;margin:.2em 0 1em}.article-nav{font-size:.82em;margin-bottom:1.8em}a{color:#111}pre{white-space:pre-wrap;font-family:monospace;font-size:.86em;background:#f2f2f2;padding:.8em}code{font-family:monospace}blockquote{margin-left:.6em;border-left:2px solid #888;padding-left:1em}figure{margin:1.4em 0}img{display:block;max-width:100%;height:auto;margin:1em auto}figcaption{line-height:1.35;margin-top:.4em}table{border-collapse:collapse;width:100%;font-size:.82em;margin:1.2em 0}th,td{border:1px solid #888;padding:.38em;vertical-align:top}th{font-weight:bold}dl{margin:1em 0}dt{font-weight:bold;margin-top:.7em}dd{margin-left:1em}.toc li{margin-bottom:.9em}.original{margin-top:2em;padding-top:1em;border-top:1px solid #999;font-size:.85em}`;
  output.file("style.css", css);
  output.file("cover.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title><style>html,body{margin:0;padding:0}img{display:block;width:100%;height:auto}</style></head><body><img src="cover.png" alt="${esc(options.name)} — ${esc(options.displayDate)}"/></body></html>`);

  const navItems = prepared.map((article, index) => `<li><a href="article-${index + 1}.xhtml">${esc(article.title)} — ${esc(article.source)}</a></li>`).join("");
  output.file("nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(options.name)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><p class="date">${esc(options.displayDate)}</p><nav epub:type="toc" id="toc"><h1>${esc(options.name)}</h1><ol class="toc">${navItems}</ol></nav></body></html>`);

  const manifest = [
    `<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>`,
    `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ];
  const spine = [`<itemref idref="cover"/>`, `<itemref idref="nav"/>`];
  prepared.forEach((article, index) => {
    const id = `article-${index + 1}`;
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    const date = article.published_at ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(article.published_at)) : "";
    const creator = article.author || article.source;
    output.file(`${id}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(article.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><p class="article-nav"><a href="nav.xhtml">Contents</a></p><h1>${esc(article.title)}</h1><p class="meta">${esc(creator)}${creator !== article.source ? ` · ${esc(article.source)}` : ""}${date ? ` · ${esc(date)}` : ""}</p>${article.body}<p class="original"><a href="${esc(article.canonical_url || article.url)}">Read the original article</a></p></body></html>`);
  });
  let assetIndex = 0;
  for (const asset of includedAssets.values()) {
    assetIndex++;
    output.file(asset.href, asset.bytes);
    manifest.push(`<item id="image-${assetIndex}" href="${esc(asset.href)}" media-type="${asset.mediaType}"/>`);
  }

  const bookId = crypto.randomUUID();
  const navPoints = prepared.map((article, index) => `<navPoint id="nav-${index + 1}" playOrder="${index + 1}"><navLabel><text>${esc(article.title)}</text></navLabel><content src="article-${index + 1}.xhtml"/></navPoint>`).join("");
  output.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${bookId}"/></head><docTitle><text>${esc(options.name)}</text></docTitle><navMap>${navPoints}</navMap></ncx>`);
  output.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier><dc:title>${esc(options.name)} — ${esc(options.displayDate)}</dc:title><dc:language>en</dc:language><dc:creator>Morning Reader</dc:creator><meta name="cover" content="cover-image"/><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta><meta property="rendition:layout">reflowable</meta></metadata><manifest>${manifest.join("")}</manifest><spine toc="ncx">${spine.join("")}</spine></package>`);
  return await zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
