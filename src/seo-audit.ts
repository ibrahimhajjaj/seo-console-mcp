import * as cheerio from "cheerio";

export interface SeoAuditResult {
  url: string;
  title: { text: string | null; count: number; length: number };
  metaDescription: { text: string | null; length: number };
  canonical: string | null;
  metaRobots: string | null;
  h1: { count: number; texts: string[] };
  headingOutline: Array<{ level: number; text: string }>;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  schemaTypes: string[];
  images: { count: number; withAlt: number; altPercentage: number };
  links: { internal: number; external: number };
  wordCount: number;
  lang: string | null;
  viewport: string | null;
  issues: string[];
}

export function parseSeoHtml(html: string, pageUrl: string): SeoAuditResult {
  const $ = cheerio.load(html);
  const clean = (value: string | undefined): string | null => value?.replace(/\s+/g, " ").trim() || null;
  // document.title semantics: SVG/MathML <title> elements are not page titles.
  const titleElements = $("title").filter((_, element) => $(element).parents("svg,math").length === 0);
  const titles = titleElements
    .map((_, element) => clean($(element).text()))
    .get()
    .filter((value): value is string => value !== null);
  const description = clean($("meta[name='description' i]").first().attr("content"));
  const canonicalHref = clean($("link[rel~='canonical' i]").first().attr("href"));
  let canonical: string | null = null;
  if (canonicalHref) {
    try {
      canonical = new URL(canonicalHref, pageUrl).toString();
    } catch {
      canonical = canonicalHref;
    }
  }

  const headings = $("h1,h2,h3,h4,h5,h6")
    .map((_, element) => ({
      level: Number(element.tagName.slice(1)),
      text: clean($(element).text()) ?? "",
    }))
    .get();
  const h1Texts = headings.filter(({ level }) => level === 1).map(({ text }) => text);
  const openGraph = collectMeta($, "property", "og:");
  const twitter = collectMeta($, "name", "twitter:");
  const { schemaTypes, invalidBlocks } = collectSchemaTypes($);

  const imageCount = $("img").length;
  const imagesWithAlt = $("img").filter((_, element) => ($(element).attr("alt") ?? "").trim() !== "").length;
  const links = countLinks($, pageUrl);

  const body = $("body").clone();
  body.find("script,style,noscript,template,svg").remove();
  const words = (clean(body.text()) ?? "").match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? [];
  const issues: string[] = [];
  if (titles.length === 0) issues.push("Missing title element");
  if (titleElements.length > 1) issues.push(`Multiple title elements (${titleElements.length})`);
  if (!description) issues.push("Missing meta description");
  if (h1Texts.length === 0) issues.push("Missing H1 heading");
  if (h1Texts.length > 1) issues.push(`Multiple H1 headings (${h1Texts.length})`);
  if (!canonical) issues.push("Missing canonical URL");
  if (schemaTypes.length === 0) issues.push("No JSON-LD schema found");
  if (invalidBlocks > 0) issues.push(`Invalid JSON-LD block (${invalidBlocks})`);

  return {
    url: pageUrl,
    title: { text: titles[0] ?? null, count: titleElements.length, length: titles[0]?.length ?? 0 },
    metaDescription: { text: description, length: description?.length ?? 0 },
    canonical,
    metaRobots: clean($("meta[name='robots' i]").first().attr("content")),
    h1: { count: h1Texts.length, texts: h1Texts },
    headingOutline: headings,
    openGraph,
    twitter,
    schemaTypes,
    images: { count: imageCount, withAlt: imagesWithAlt, altPercentage: imageCount === 0 ? 100 : Math.round((imagesWithAlt / imageCount) * 1000) / 10 },
    links,
    wordCount: words.length,
    lang: clean($("html").attr("lang")),
    viewport: clean($("meta[name='viewport' i]").first().attr("content")),
    issues,
  };
}

function collectMeta($: cheerio.CheerioAPI, attribute: "name" | "property", prefix: string): Record<string, string> {
  const result: Record<string, string> = {};
  $(`meta[${attribute}]`).each((_, element) => {
    const key = $(element).attr(attribute)?.toLowerCase();
    const value = $(element).attr("content")?.trim();
    if (key?.startsWith(prefix) && value) result[key.slice(prefix.length)] = value;
  });
  return result;
}

function collectSchemaTypes($: cheerio.CheerioAPI): { schemaTypes: string[]; invalidBlocks: number } {
  const types = new Set<string>();
  let invalidBlocks = 0;
  $("script[type='application/ld+json' i]").each((_, element) => {
    try {
      visitJsonLd(JSON.parse($(element).text()) as unknown, types);
    } catch {
      invalidBlocks += 1;
    }
  });
  return { schemaTypes: [...types], invalidBlocks };
}

function visitJsonLd(value: unknown, types: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitJsonLd(entry, types));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const type = record["@type"];
    if (typeof type === "string") types.add(type);
    if (Array.isArray(type)) type.filter((entry): entry is string => typeof entry === "string").forEach((entry) => types.add(entry));
    if (record["@graph"]) visitJsonLd(record["@graph"], types);
  }
}

function countLinks($: cheerio.CheerioAPI, pageUrl: string): { internal: number; external: number } {
  const pageHost = new URL(pageUrl).hostname;
  let internal = 0;
  let external = 0;
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href")?.trim();
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    try {
      const target = new URL(href, pageUrl);
      if (target.protocol !== "http:" && target.protocol !== "https:") return;
      if (target.hostname === pageHost) internal += 1;
      else external += 1;
    } catch {
      /* ignore malformed links */
    }
  });
  return { internal, external };
}
