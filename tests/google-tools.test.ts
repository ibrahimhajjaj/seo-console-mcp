import { describe, expect, it, vi } from "vitest";
import {
  inspectUrl,
  listSitemaps,
  runPageSpeed,
  searchAnalytics,
  submitSitemap,
  type GoogleClients,
} from "../src/google-tools.js";

function fakeClients(): GoogleClients {
  return {
    searchConsole: {
      searchanalytics: { query: vi.fn() },
      sitemaps: { list: vi.fn(), submit: vi.fn() },
      urlInspection: { index: { inspect: vi.fn() } },
    },
    pageSpeed: { pagespeedapi: { runpagespeed: vi.fn() } },
  };
}

describe("Google-backed tool operations", () => {
  it("queries search analytics with defaults and formats ranked rows", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: [
      { keys: ["seo mcp"], clicks: 12, impressions: 100, ctr: 0.12, position: 3.456 },
    ] } });

    const result = await searchAnalytics(clients, {
      siteUrl: "https://example.com/",
      dimensions: ["query"],
      rowLimit: 25,
    }, new Date("2026-07-11T12:00:00Z"));

    expect(clients.searchConsole.searchanalytics.query).toHaveBeenCalledWith({
      siteUrl: "https://example.com/",
      requestBody: {
        startDate: "2026-06-14",
        endDate: "2026-07-11",
        dimensions: ["query"],
        rowLimit: 25,
      },
    });
    expect(result.content[0]?.text).toContain("seo mcp | 12 | 100 | 12.00% | 3.46");
    expect(result.structuredContent).toMatchObject({ rowCount: 1, rows: [{ rank: 1, keys: { query: "seo mcp" } }] });
  });

  it("escapes delimiters and newlines only in search analytics text", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: [
      { keys: ["buy cats | dogs"], clicks: 4, impressions: 20, ctr: 0.2, position: 2 },
      { keys: ["first\nsecond"], clicks: 3, impressions: 15, ctr: 0.2, position: 4 },
    ] } });

    const result = await searchAnalytics(clients, {
      siteUrl: "https://example.com/",
      dimensions: ["query"],
      rowLimit: 25,
    }, new Date("2026-07-11T12:00:00Z"));

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("1 | buy cats \\| dogs | 4 | 20 | 20.00% | 2.00");
    expect(text).toContain("2 | first second | 3 | 15 | 20.00% | 4.00");
    expect(text).not.toContain("first\nsecond");
    expect(result.structuredContent).toMatchObject({ rows: [
      { keys: { query: "buy cats | dogs" } },
      { keys: { query: "first\nsecond" } },
    ] });
  });

  it("passes search filters and type through", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: {} });
    const groups = [{ groupType: "and" as const, filters: [{ dimension: "query" as const, operator: "contains" as const, expression: "seo" }] }];
    await searchAnalytics(clients, {
      siteUrl: "sc-domain:example.com", startDate: "2026-07-01", endDate: "2026-07-10",
      dimensions: ["page"], rowLimit: 10, dimensionFilterGroups: groups, type: "image",
    });
    expect(clients.searchConsole.searchanalytics.query).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({ dimensionFilterGroups: groups, type: "image" }) }));
  });

  it("lists sitemaps and shapes their contents", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sitemaps.list).mockResolvedValue({ data: { sitemap: [{
      path: "https://example.com/sitemap.xml", lastSubmitted: "2026-07-01T00:00:00Z",
      isPending: false, warnings: "1", errors: "0", contents: [{ type: "web", submitted: "42", indexed: "40" }],
    }] } });
    const result = await listSitemaps(clients, { siteUrl: "https://example.com/" });
    expect(clients.searchConsole.sitemaps.list).toHaveBeenCalledWith({ siteUrl: "https://example.com/" });
    expect(result.structuredContent).toMatchObject({ count: 1, sitemaps: [{ warnings: 1, errors: 0, contents: [{ submitted: 42 }] }] });
  });

  it("submits then re-lists the sitemap", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sitemaps.submit).mockResolvedValue({ data: undefined });
    vi.mocked(clients.searchConsole.sitemaps.list).mockResolvedValue({ data: { sitemap: [{ path: "https://example.com/sitemap.xml", isPending: true }] } });
    const result = await submitSitemap(clients, { siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml" });
    expect(clients.searchConsole.sitemaps.submit).toHaveBeenCalledWith({ siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml" });
    expect(clients.searchConsole.sitemaps.list).toHaveBeenCalledWith({ siteUrl: "https://example.com/" });
    expect(result.structuredContent).toMatchObject({ success: true, sitemap: { isPending: true } });
  });

  it("reports an accepted sitemap if refreshing state fails", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sitemaps.submit).mockResolvedValue({ data: undefined });
    vi.mocked(clients.searchConsole.sitemaps.list).mockRejectedValue(new Error("temporary list failure"));
    const result = await submitSitemap(clients, { siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml" });
    expect(result.structuredContent).toMatchObject({ success: true, sitemap: null, stateRefreshError: "temporary list failure" });
    expect(result.content[0]?.text).toContain("accepted");
  });

  it("inspects URL index, mobile usability, and rich results", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.urlInspection.index.inspect).mockResolvedValue({ data: { inspectionResult: {
      indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", googleCanonical: "https://example.com/page", userCanonical: "https://example.com/page" },
      mobileUsabilityResult: { verdict: "PASS" }, richResultsResult: { verdict: "PASS", detectedItems: [{ richResultType: "Breadcrumbs" }] },
    } } });
    const result = await inspectUrl(clients, { siteUrl: "sc-domain:example.com", inspectionUrl: "https://example.com/page" });
    expect(clients.searchConsole.urlInspection.index.inspect).toHaveBeenCalledWith({ requestBody: { siteUrl: "sc-domain:example.com", inspectionUrl: "https://example.com/page" } });
    expect(result.structuredContent).toMatchObject({ indexStatus: { verdict: "PASS" }, mobileUsability: { verdict: "PASS" }, richResults: { detectedItems: [{ richResultType: "Breadcrumbs" }] } });
  });

  it("extracts PageSpeed field data, category scores, and opportunities", async () => {
    const clients = fakeClients();
    vi.mocked(clients.pageSpeed.pagespeedapi.runpagespeed).mockResolvedValue({ data: {
      loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2400, category: "AVERAGE" }, INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" } } },
      lighthouseResult: { categories: { performance: { score: 0.91 }, seo: { score: 0.95 } }, audits: {
        "render-blocking-resources": { title: "Eliminate render-blocking resources", score: 0, details: { overallSavingsMs: 450 }, numericValue: 800 },
      } },
    } });
    const result = await runPageSpeed(clients, { url: "https://example.com/", strategy: "mobile", category: ["performance", "seo"], apiKey: "test-key" });
    expect(clients.pageSpeed.pagespeedapi.runpagespeed).toHaveBeenCalledWith({ url: "https://example.com/", strategy: "mobile", category: ["performance", "seo"], key: "test-key" });
    expect(result.structuredContent).toMatchObject({ fieldData: { lcp: { value: 2400 }, inp: { value: 180 } }, scores: { performance: 91, seo: 95 }, opportunities: [{ savingsMs: 450 }] });
  });
});
