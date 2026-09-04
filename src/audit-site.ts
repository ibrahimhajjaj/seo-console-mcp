import * as cheerio from "cheerio";
import { fetchHtml } from "./fetch-page.js";
import { parseSeoHtml } from "./seo-audit.js";
import { mapWithConcurrency } from "./concurrency.js";

export { mapWithConcurrency } from "./concurrency.js";

const MAX_CHILD_SITEMAPS = 5;

export interface AuditSiteOptions {
  maxPages?: number;
  concurrency?: number;
  fetchImpl?: typeof fetchHtml;
}

export interface AuditSitePage {
  url: string;
  issues?: string[];
  title?: string | null;
  metaDescription?: string | null;
  h1?: string[];
  error?: string;
}

export interface AuditSiteResult {
  sitemapUrl: string;
  totalDiscovered: number;
  audited: number;
  failed: number;
  truncated: boolean;
  skipped: number;
  childSitemapsSkipped: number;
  childSitemapsFailed: number;
  pages: AuditSitePage[];
  rollup: Record<string, number>;
}

export function parseSitemapUrls(xml: string): { urls: string[]; childSitemaps: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  // An HTML error page or an undecompressed .gz blob has no <loc> elements
  // either, and returning zero URLs for it would report a broken sitemap as a
  // healthy empty one. Only a real sitemap root earns the right to say zero.
  if ($("urlset").length === 0 && $("sitemapindex").length === 0) {
    throw new Error(
      "The document is not a sitemap: it has no <urlset> or <sitemapindex> root. If it is a .gz file that could not be decompressed, or an HTML error page, that is what this is reporting.",
    );
  }
  const collect = (selector: string): string[] =>
    $(selector)
      .map((_, element) => $(element).text().trim())
      .get()
      .filter((value) => value.length > 0);
  return { urls: collect("url > loc"), childSitemaps: collect("sitemap > loc") };
}

export async function auditSite(sitemapUrl: string, options: AuditSiteOptions = {}): Promise<AuditSiteResult> {
  const maxPages = options.maxPages ?? 20;
  const concurrency = options.concurrency ?? 5;
  const fetchImpl = options.fetchImpl ?? fetchHtml;
  const sitemap = await fetchImpl(sitemapUrl);
  const parsed = parseSitemapUrls(sitemap.html);
  const pageUrls = [...parsed.urls];
  let childSitemapsSkipped = 0;
  let childSitemapsFailed = 0;

  if (pageUrls.length === 0 && parsed.childSitemaps.length > 0) {
    const children = parsed.childSitemaps.slice(0, MAX_CHILD_SITEMAPS);
    childSitemapsSkipped = parsed.childSitemaps.length - children.length;
    for (const childUrl of children) {
      // Isolate each child: one bad child sitemap must not abort the whole audit
      // or discard pages already gathered from earlier children.
      try {
        const child = await fetchImpl(childUrl);
        pageUrls.push(...parseSitemapUrls(child.html).urls);
      } catch {
        childSitemapsFailed += 1;
      }
      if (pageUrls.length >= maxPages) {
        childSitemapsSkipped += children.length - children.indexOf(childUrl) - 1;
        break;
      }
    }
  }

  const selectedUrls = pageUrls.slice(0, maxPages);
  const pages = await mapWithConcurrency(selectedUrls, concurrency, async (url): Promise<AuditSitePage> => {
    try {
      const page = await fetchImpl(url);
      const audit = parseSeoHtml(page.html, page.finalUrl);
      return {
        url,
        issues: audit.issues,
        title: audit.title.text,
        metaDescription: audit.metaDescription.text,
        h1: audit.h1.texts,
      };
    } catch (error) {
      return { url, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const rollup: Record<string, number> = {};
  for (const page of pages) {
    for (const issue of page.issues ?? []) rollup[issue] = (rollup[issue] ?? 0) + 1;
  }
  const failed = pages.filter((page) => page.error !== undefined).length;
  const skipped = Math.max(0, pageUrls.length - selectedUrls.length);

  return {
    sitemapUrl,
    totalDiscovered: pageUrls.length,
    audited: pages.length - failed,
    failed,
    truncated: skipped > 0 || childSitemapsSkipped > 0,
    skipped,
    childSitemapsSkipped,
    childSitemapsFailed,
    pages,
    rollup,
  };
}
