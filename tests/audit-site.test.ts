import { describe, expect, it } from "vitest";
import { auditSite, parseSitemapUrls } from "../src/audit-site.js";
import type { fetchHtml } from "../src/fetch-page.js";

const completeHtml = (title: string): string => `<!doctype html><html lang="en"><head>
  <title>${title}</title><meta name="description" content="Description">
  <link rel="canonical" href="/"><meta name="viewport" content="width=device-width">
  <script type="application/ld+json">{"@type":"WebPage"}</script>
</head><body><h1>${title}</h1></body></html>`;

function page(html: string, finalUrl: string) {
  return { html, finalUrl, status: 200 };
}

describe("parseSitemapUrls", () => {
  it("collects non-empty page URLs from a URL set", () => {
    const parsed = parseSitemapUrls(`<?xml version="1.0"?><urlset>
      <url><loc> https://example.com/one </loc></url>
      <url><loc>https://example.com/two</loc></url>
      <url><loc>https://example.com/three</loc></url><url><loc> </loc></url>
    </urlset>`);
    expect(parsed).toEqual({
      urls: ["https://example.com/one", "https://example.com/two", "https://example.com/three"],
      childSitemaps: [],
    });
  });

  it("collects child sitemap URLs from a sitemap index", () => {
    const parsed = parseSitemapUrls(`<sitemapindex>
      <sitemap><loc>https://example.com/posts.xml</loc></sitemap>
      <sitemap><loc> https://example.com/pages.xml </loc></sitemap>
    </sitemapindex>`);
    expect(parsed).toEqual({
      urls: [],
      childSitemaps: ["https://example.com/posts.xml", "https://example.com/pages.xml"],
    });
  });

  it("throws for a document with no sitemap root", () => {
    expect(() => parseSitemapUrls("<html><body>Not found</body></html>")).toThrow(/not a sitemap/);
  });

  it("returns nothing for an empty but well-formed URL set", () => {
    expect(parseSitemapUrls("<urlset></urlset>")).toEqual({ urls: [], childSitemaps: [] });
  });
});

describe("auditSite", () => {
  it("audits pages and rolls up shared issues", async () => {
    const sitemapUrl = "https://example.com/sitemap.xml";
    const urls = ["https://example.com/one", "https://example.com/two"];
    const fetchImpl: typeof fetchHtml = async (url) => url === sitemapUrl
      ? page(`<urlset>${urls.map((entry) => `<url><loc>${entry}</loc></url>`).join("")}</urlset>`, url)
      : page("<html><body><h1>Page</h1></body></html>", url);

    const result = await auditSite(sitemapUrl, { fetchImpl });

    expect(result.audited).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.pages).toHaveLength(2);
    expect(result.rollup["Missing title element"]).toBe(2);
    expect(result.rollup["Missing meta description"]).toBe(2);
  });

  it("isolates a failed child sitemap and continues with the valid ones", async () => {
    const sitemapUrl = "https://example.com/sitemap.xml";
    const fetchImpl: typeof fetchHtml = async (url) => {
      if (url === sitemapUrl) return page("<sitemapindex><sitemap><loc>https://example.com/bad.xml</loc></sitemap><sitemap><loc>https://example.com/good.xml</loc></sitemap></sitemapindex>", url);
      if (url === "https://example.com/bad.xml") throw new Error("child sitemap 503");
      if (url === "https://example.com/good.xml") return page("<urlset><url><loc>https://example.com/page-a</loc></url></urlset>", url);
      return page("<html><body><h1>Page</h1></body></html>", url);
    };

    const result = await auditSite(sitemapUrl, { fetchImpl });

    expect(result.childSitemapsFailed).toBe(1);
    expect(result.audited).toBe(1);
    expect(result.pages.map((entry) => entry.url)).toEqual(["https://example.com/page-a"]);
  });

  it("respects the concurrency limit", async () => {
    const sitemapUrl = "https://example.com/sitemap.xml";
    const urls = Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: typeof fetchHtml = async (url) => {
      if (url === sitemapUrl) return page(`<urlset>${urls.map((entry) => `<url><loc>${entry}</loc></url>`).join("")}</urlset>`, url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return page(completeHtml(url), url);
    };

    await auditSite(sitemapUrl, { concurrency: 2, fetchImpl });

    expect(maxInFlight).toBe(2);
  });

  it("isolates a failed page fetch", async () => {
    const sitemapUrl = "https://example.com/sitemap.xml";
    const goodUrl = "https://example.com/good";
    const badUrl = "https://example.com/bad";
    const fetchImpl: typeof fetchHtml = async (url) => {
      if (url === sitemapUrl) return page(`<urlset><url><loc>${goodUrl}</loc></url><url><loc>${badUrl}</loc></url></urlset>`, url);
      if (url === badUrl) throw new Error("HTTP 503");
      return page(completeHtml("Good"), url);
    };

    const result = await auditSite(sitemapUrl, { fetchImpl });

    expect(result.audited).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.pages.find(({ url }) => url === badUrl)).toEqual({ url: badUrl, error: "HTTP 503" });
  });

  it("reports truncation and skipped URLs", async () => {
    const sitemapUrl = "https://example.com/sitemap.xml";
    const urls = ["https://example.com/one", "https://example.com/two", "https://example.com/three"];
    const fetchImpl: typeof fetchHtml = async (url) => url === sitemapUrl
      ? page(`<urlset>${urls.map((entry) => `<url><loc>${entry}</loc></url>`).join("")}</urlset>`, url)
      : page(completeHtml(url), url);

    const result = await auditSite(sitemapUrl, { maxPages: 2, fetchImpl });

    expect(result.totalDiscovered).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.pages).toHaveLength(2);
  });

  it("loads page URLs from child sitemaps with a hard child-fetch cap", async () => {
    const sitemapUrl = "https://example.com/sitemap.xml";
    const children = Array.from({ length: 7 }, (_, index) => `https://example.com/child-${index}.xml`);
    const fetchedChildren: string[] = [];
    const fetchImpl: typeof fetchHtml = async (url) => {
      if (url === sitemapUrl) return page(`<sitemapindex>${children.map((entry) => `<sitemap><loc>${entry}</loc></sitemap>`).join("")}</sitemapindex>`, url);
      if (children.includes(url)) {
        fetchedChildren.push(url);
        return page(`<urlset><url><loc>${url.replace(".xml", "")}</loc></url></urlset>`, url);
      }
      return page(completeHtml(url), url);
    };

    const result = await auditSite(sitemapUrl, { maxPages: 20, fetchImpl });

    expect(fetchedChildren).toHaveLength(5);
    expect(result.audited).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.childSitemapsSkipped).toBe(2);
  });

  it("fails loudly when the sitemap URL serves something that is not a sitemap", async () => {
    const sitemapUrl = "https://example.com/sitemap.xml";
    const fetchImpl: typeof fetchHtml = async (url) => page("<html><body>Not found</body></html>", url);

    await expect(auditSite(sitemapUrl, { fetchImpl })).rejects.toThrow(/not a sitemap/);
  });
});
