import { describe, expect, it, vi } from "vitest";
import {
  compareSearchPeriods,
  ctrGapsTool,
  deleteSitemap,
  indexCoverage,
  inspectUrl,
  listProperties,
  listSitemaps,
  queryCannibalization,
  runPageSpeed,
  searchAnalytics,
  searchOpportunities,
  submitSitemap,
  type GoogleClients,
} from "../src/google-tools.js";

function fakeClients(): GoogleClients {
  return {
    searchConsole: {
      searchanalytics: { query: vi.fn() },
      sites: { list: vi.fn() },
      sitemaps: { delete: vi.fn(), list: vi.fn(), submit: vi.fn() },
      urlInspection: { index: { inspect: vi.fn() } },
    },
    pageSpeed: { pagespeedapi: { runpagespeed: vi.fn() } },
  };
}

describe("Google-backed tool operations", () => {
  it("finds striking-distance search opportunities", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: [
      { keys: ["seo guide", "https://example.com/guide"], clicks: 12, impressions: 500, ctr: 0.024, position: 8 },
      { keys: ["already first", "https://example.com/first"], clicks: 30, impressions: 200, ctr: 0.15, position: 2 },
    ] } });

    const output = await searchOpportunities(clients, { siteUrl: "https://example.com/" }, new Date("2026-07-11T12:00:00Z"));

    expect(clients.searchConsole.searchanalytics.query).toHaveBeenCalledWith({ siteUrl: "https://example.com/", requestBody: {
      startDate: "2026-06-14", endDate: "2026-07-11", dimensions: ["query", "page"], rowLimit: 5000,
    } });
    expect(output.structuredContent).toMatchObject({
      window: { startDate: "2026-06-14", endDate: "2026-07-11" },
      opportunities: [{ keys: ["seo guide", "https://example.com/guide"], opportunity: 4000 }],
    });
  });

  it("compares current search performance with the preceding equal window", async () => {
    const clients = fakeClients();
    const query = vi.mocked(clients.searchConsole.searchanalytics.query);
    query.mockResolvedValueOnce({ data: { rows: [{ keys: ["seo"], clicks: 12, impressions: 100, ctr: 0.12, position: 4 }] } });
    query.mockResolvedValueOnce({ data: { rows: [{ keys: ["seo"], clicks: 5, impressions: 80, ctr: 0.0625, position: 6 }] } });

    const output = await compareSearchPeriods(clients, {
      siteUrl: "https://example.com/", startDate: "2026-07-01", endDate: "2026-07-10", by: "query",
    });

    expect(query).toHaveBeenNthCalledWith(1, { siteUrl: "https://example.com/", requestBody: {
      startDate: "2026-07-01", endDate: "2026-07-10", dimensions: ["query"], rowLimit: 5000,
    } });
    expect(query).toHaveBeenNthCalledWith(2, { siteUrl: "https://example.com/", requestBody: {
      startDate: "2026-06-21", endDate: "2026-06-30", dimensions: ["query"], rowLimit: 5000,
    } });
    expect(output.structuredContent).toMatchObject({
      currentWindow: { startDate: "2026-07-01", endDate: "2026-07-10" },
      previousWindow: { startDate: "2026-06-21", endDate: "2026-06-30" },
      gainers: [{ keys: ["seo"], clicksDelta: 7 }], losers: [],
    });
  });

  it("finds rows whose CTR trails peers at the same position", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: [
      { keys: ["weak snippet"], clicks: 10, impressions: 1000, ctr: 0.01, position: 4.1 },
      { keys: ["strong snippet"], clicks: 100, impressions: 1000, ctr: 0.1, position: 4.2 },
    ] } });

    const output = await ctrGapsTool(clients, { siteUrl: "https://example.com/", by: "query" });

    expect(output.structuredContent).toMatchObject({ gaps: [
      { keys: ["weak snippet"], expectedCtr: 0.1, missedClicks: 90 },
    ] });
  });

  it("groups queries served by competing pages", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: [
      { keys: ["seo", "https://example.com/a"], clicks: 5, impressions: 100, ctr: 0.05, position: 6 },
      { keys: ["seo", "https://example.com/b"], clicks: 3, impressions: 70, ctr: 0.043, position: 8 },
    ] } });

    const output = await queryCannibalization(clients, { siteUrl: "https://example.com/" });

    expect(output.structuredContent).toMatchObject({ groups: [{ query: "seo", pages: [
      { page: "https://example.com/a", impressions: 100 },
      { page: "https://example.com/b", impressions: 70 },
    ] }] });
  });

  it("lists Search Console properties", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sites.list).mockResolvedValue({ data: { siteEntry: [
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
    ] } });

    const result = await listProperties(clients);

    expect(clients.searchConsole.sites.list).toHaveBeenCalledWith({});
    expect(result.structuredContent).toMatchObject({
      count: 2,
      properties: [
        { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
      ],
    });
    expect(result.content[0]?.text).toContain("sc-domain:example.com (siteOwner)");
  });

  it("guides users when no Search Console properties are available", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sites.list).mockResolvedValue({ data: {} });

    const result = await listProperties(clients);

    expect(result.structuredContent).toEqual({ count: 0, properties: [] });
    expect(result.content[0]?.text).toContain("No properties. Run `seo-mcp verify <domain>` to add one.");
  });

  it("queries search analytics with defaults and formats ranked rows", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: [
      { keys: ["seo mcp"], clicks: 12, impressions: 100, ctr: 0.12, position: 3.456 },
    ] } });

    const result = await searchAnalytics(clients, {
      siteUrl: "https://example.com/",
      dimensions: ["query"],
      rowLimit: 25,
      maxTableRows: 25,
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

  it("caps search analytics text rows while preserving structured rows", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: Array.from({ length: 5 }, (_, index) => ({
      keys: [`query ${index + 1}`], clicks: index + 1, impressions: 10, ctr: 0.1, position: index + 1,
    })) } });

    const result = await searchAnalytics(clients, {
      siteUrl: "https://example.com/", dimensions: ["query"], rowLimit: 25, maxTableRows: 2,
    }, new Date("2026-07-11T12:00:00Z"));

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("1 | query 1");
    expect(text).toContain("2 | query 2");
    expect(text).not.toContain("3 | query 3");
    expect(text).toContain("... 3 more rows (see structured data).");
    expect(result.structuredContent.rows).toHaveLength(5);
  });

  it("returns a summary without a table when the text row budget is zero", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: Array.from({ length: 5 }, (_, index) => ({
      keys: [`query ${index + 1}`], clicks: index + 1, impressions: 10, ctr: 0.1, position: index + 1,
    })) } });

    const result = await searchAnalytics(clients, {
      siteUrl: "https://example.com/", dimensions: ["query"], rowLimit: 25, maxTableRows: 0,
    }, new Date("2026-07-11T12:00:00Z"));

    const text = result.content[0]?.text ?? "";
    expect(text).toBe("Search analytics for https://example.com/ returned 5 rows (2026-06-14 to 2026-07-11). See structured data.");
    expect(text).not.toContain("Clicks | Impressions");
    expect(result.structuredContent.rows).toHaveLength(5);
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
      maxTableRows: 25,
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

  it("passes search filters, type, data state, and aggregation type through", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: {} });
    const groups = [{ groupType: "and" as const, filters: [{ dimension: "query" as const, operator: "contains" as const, expression: "seo" }] }];
    await searchAnalytics(clients, {
      siteUrl: "sc-domain:example.com", startDate: "2026-07-01", endDate: "2026-07-10",
      dimensions: ["page"], rowLimit: 10, dimensionFilterGroups: groups, type: "image",
      maxTableRows: 25,
      dataState: "all", aggregationType: "byPage",
    });
    expect(clients.searchConsole.searchanalytics.query).toHaveBeenCalledWith(expect.objectContaining({ requestBody: expect.objectContaining({
      dimensionFilterGroups: groups,
      type: "image",
      dataState: "all",
      aggregationType: "byPage",
    }) }));
  });

  it("surfaces the first incomplete search analytics date", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: {
      metadata: { firstIncompleteDate: "2026-07-10" },
    } });

    const result = await searchAnalytics(clients, {
      siteUrl: "sc-domain:example.com",
      dimensions: ["date"],
      rowLimit: 25,
      maxTableRows: 25,
      dataState: "all",
    }, new Date("2026-07-11T12:00:00Z"));

    expect(result.structuredContent).toMatchObject({ firstIncompleteDate: "2026-07-10" });
    expect(result.content[0]?.text).toContain("Note: data from 2026-07-10 onward is still being collected.");
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

  it("does not write to Search Console on a dry-run submit", async () => {
    const clients = fakeClients();
    const result = await submitSitemap(clients, { siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml", dryRun: true });
    expect(clients.searchConsole.sitemaps.submit).not.toHaveBeenCalled();
    expect(clients.searchConsole.sitemaps.list).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ success: true, dryRun: true, sitemap: null, stateRefreshError: null });
    expect(result.content[0]?.text).toContain("Dry run");
  });

  it("reports an accepted sitemap if refreshing state fails", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sitemaps.submit).mockResolvedValue({ data: undefined });
    vi.mocked(clients.searchConsole.sitemaps.list).mockRejectedValue(new Error("temporary list failure"));
    const result = await submitSitemap(clients, { siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml" });
    expect(result.structuredContent).toMatchObject({ success: true, sitemap: null, stateRefreshError: "temporary list failure" });
    expect(result.content[0]?.text).toContain("accepted");
  });

  it("deletes a sitemap", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sitemaps.delete).mockResolvedValue({ data: undefined });
    const result = await deleteSitemap(clients, { siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml" });
    expect(clients.searchConsole.sitemaps.delete).toHaveBeenCalledWith({ siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml" });
    expect(result.structuredContent).toMatchObject({ success: true });
  });

  it("does not delete a sitemap on a dry run", async () => {
    const clients = fakeClients();
    const result = await deleteSitemap(clients, { siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml", dryRun: true });
    expect(clients.searchConsole.sitemaps.delete).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ success: true, dryRun: true });
    expect(result.content[0]?.text).toContain("Dry run");
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

  it("rolls up indexed and not-indexed sitemap URLs", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.urlInspection.index.inspect)
      .mockResolvedValueOnce({ data: { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2026-07-10T00:00:00Z" } } } })
      .mockResolvedValueOnce({ data: { inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" } } } })
      .mockResolvedValueOnce({ data: { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Indexed, not submitted in sitemap" } } } });

    const output = await indexCoverage(clients, {
      siteUrl: "sc-domain:example.com",
      sitemapUrl: "https://example.com/sitemap.xml",
      maxUrls: 20,
      concurrency: 3,
    }, { fetchImpl: vi.fn().mockResolvedValue({ html: sitemap("a", "b", "c") }) });

    expect(output.structuredContent).toMatchObject({
      totalDiscovered: 3,
      checked: 3,
      indexed: 2,
      failed: 0,
      truncated: false,
      notIndexed: [{ url: "https://example.com/b", coverageState: "Crawled - currently not indexed" }],
    });
  });

  it("isolates URL inspection failures", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.urlInspection.index.inspect)
      .mockResolvedValueOnce({ data: { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } } })
      .mockRejectedValueOnce(new Error("inspection unavailable"));

    const output = await indexCoverage(clients, {
      siteUrl: "sc-domain:example.com",
      sitemapUrl: "https://example.com/sitemap.xml",
      maxUrls: 20,
      concurrency: 3,
    }, { fetchImpl: vi.fn().mockResolvedValue({ html: sitemap("a", "b") }) });

    expect(output.structuredContent).toMatchObject({ checked: 2, indexed: 1, failed: 1 });
    expect(output.structuredContent.results).toContainEqual(expect.objectContaining({
      url: "https://example.com/b",
      indexed: false,
      error: "inspection unavailable",
    }));
  });

  it("limits sitemap inspections and reports truncation", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.urlInspection.index.inspect).mockResolvedValue({ data: { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } } });

    const output = await indexCoverage(clients, {
      siteUrl: "sc-domain:example.com",
      sitemapUrl: "https://example.com/sitemap.xml",
      maxUrls: 2,
      concurrency: 1,
    }, { fetchImpl: vi.fn().mockResolvedValue({ html: sitemap("a", "b", "c") }) });

    expect(clients.searchConsole.urlInspection.index.inspect).toHaveBeenCalledTimes(2);
    expect(output.structuredContent).toMatchObject({ totalDiscovered: 3, checked: 2, truncated: true });
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

function sitemap(...paths: string[]): string {
  return `<urlset>${paths.map((path) => `<url><loc>https://example.com/${path}</loc></url>`).join("")}</urlset>`;
}
