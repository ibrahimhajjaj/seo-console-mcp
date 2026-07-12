import { auth as googleAuth, searchconsole, type searchconsole_v1 } from "@googleapis/searchconsole";
import { pagespeedonline, type pagespeedonline_v5 } from "@googleapis/pagespeedonline";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type {
  compareSearchPeriodsInput,
  ctrGapsInput,
  inspectUrlInput,
  listSitemapsInput,
  pageSpeedInput,
  queryCannibalizationInput,
  searchAnalyticsInput,
  searchOpportunitiesInput,
  submitSitemapInput,
} from "./schemas.js";
import { cannibalization, comparePeriods, ctrGaps, strikingDistance, type InsightRow } from "./insights.js";

type SearchAnalyticsParams = z.output<typeof searchAnalyticsInput>;
type ListSitemapsParams = z.output<typeof listSitemapsInput>;
type SubmitSitemapParams = z.output<typeof submitSitemapInput>;
type InspectUrlParams = z.output<typeof inspectUrlInput>;
type PageSpeedParams = z.output<typeof pageSpeedInput>;
type SearchOpportunitiesParams = z.output<typeof searchOpportunitiesInput>;
type CompareSearchPeriodsParams = z.output<typeof compareSearchPeriodsInput>;
type CtrGapsParams = z.output<typeof ctrGapsInput>;
type QueryCannibalizationParams = z.output<typeof queryCannibalizationInput>;

export type ToolResult = Omit<CallToolResult, "content" | "structuredContent"> & {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

type ApiResponse<T> = Promise<{ data: T }>;

export interface GoogleClients {
  searchConsole: {
    searchanalytics: { query(params: searchconsole_v1.Params$Resource$Searchanalytics$Query): ApiResponse<searchconsole_v1.Schema$SearchAnalyticsQueryResponse> };
    sites: { list(params: searchconsole_v1.Params$Resource$Sites$List): ApiResponse<searchconsole_v1.Schema$SitesListResponse> };
    sitemaps: {
      list(params: searchconsole_v1.Params$Resource$Sitemaps$List): ApiResponse<searchconsole_v1.Schema$SitemapsListResponse>;
      submit(params: searchconsole_v1.Params$Resource$Sitemaps$Submit): ApiResponse<void>;
    };
    urlInspection: { index: { inspect(params: searchconsole_v1.Params$Resource$Urlinspection$Index$Inspect): ApiResponse<searchconsole_v1.Schema$InspectUrlIndexResponse> } };
  };
  pageSpeed: {
    pagespeedapi: { runpagespeed(params: pagespeedonline_v5.Params$Resource$Pagespeedapi$Runpagespeed): ApiResponse<pagespeedonline_v5.Schema$PagespeedApiPagespeedResponseV5> };
  };
}

// Values can contain the cell delimiter or newlines, so text table cells must remain single-line.
function tableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

export function createGoogleClients(credentialsPath?: string): GoogleClients {
  const auth = new googleAuth.GoogleAuth({
    ...(credentialsPath ? { keyFile: credentialsPath } : {}),
    scopes: [
      "https://www.googleapis.com/auth/webmasters",
      "https://www.googleapis.com/auth/webmasters.readonly",
    ],
  });
  return {
    searchConsole: searchconsole({ version: "v1", auth }),
    pageSpeed: pagespeedonline({ version: "v5" }),
  };
}

export async function searchAnalytics(clients: GoogleClients, params: SearchAnalyticsParams, now = new Date()): Promise<ToolResult> {
  const { startDate, endDate } = analysisWindow(params, now);

  const requestBody: searchconsole_v1.Schema$SearchAnalyticsQueryRequest = {
    startDate,
    endDate,
    dimensions: params.dimensions,
    rowLimit: params.rowLimit,
    ...(params.dimensionFilterGroups ? { dimensionFilterGroups: params.dimensionFilterGroups } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.dataState ? { dataState: params.dataState } : {}),
    ...(params.aggregationType ? { aggregationType: params.aggregationType } : {}),
  };
  const response = await clients.searchConsole.searchanalytics.query({ siteUrl: params.siteUrl, requestBody });
  const firstIncompleteDate = response.data.metadata?.firstIncompleteDate
    ?? response.data.metadata?.firstIncompleteHour;
  const rows = (response.data.rows ?? []).map((row, index) => ({
    rank: index + 1,
    keys: Object.fromEntries(params.dimensions.map((dimension, keyIndex) => [dimension, row.keys?.[keyIndex] ?? ""])),
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));

  const lines = params.maxTableRows === 0
    ? [`Search analytics for ${params.siteUrl} returned ${rows.length} rows (${startDate} to ${endDate}). See structured data.`]
    : [
      `Search analytics for ${params.siteUrl} (${startDate} to ${endDate})`,
      `# | ${params.dimensions.join(" / ")} | Clicks | Impressions | CTR | Position`,
      `--- | --- | ---: | ---: | ---: | ---:`,
      ...rows.slice(0, params.maxTableRows).map((row) => `${row.rank} | ${params.dimensions.map((dimension) => tableCell(String(row.keys[dimension]))).join(" / ")} | ${row.clicks} | ${row.impressions} | ${(row.ctr * 100).toFixed(2)}% | ${row.position.toFixed(2)}`),
    ];
  if (params.maxTableRows > 0 && rows.length === 0) lines.push("No rows returned.");
  if (params.maxTableRows > 0 && rows.length > params.maxTableRows) {
    lines.push(`... ${rows.length - params.maxTableRows} more rows (see structured data).`);
  }
  if (firstIncompleteDate) lines.push(`Note: data from ${firstIncompleteDate} onward is still being collected.`);
  return result(lines.join("\n"), {
    siteUrl: params.siteUrl,
    startDate,
    endDate,
    dimensions: params.dimensions,
    rowCount: rows.length,
    rows,
    ...(firstIncompleteDate ? { firstIncompleteDate } : {}),
  });
}

export async function searchOpportunities(clients: GoogleClients, params: SearchOpportunitiesParams, now = new Date()): Promise<ToolResult> {
  const window = analysisWindow(params, now);
  const rows = await fetchInsightRows(clients, params.siteUrl, insightRequest(window, ["query", "page"]));
  const opportunities = strikingDistance(rows, {
    minPosition: params.minPosition ?? 5,
    maxPosition: params.maxPosition ?? 20,
    minImpressions: params.minImpressions ?? 10,
    limit: params.limit ?? 50,
  });
  const lines = [
    `Search opportunities for ${params.siteUrl} (${window.startDate} to ${window.endDate})`,
    "Query | Page | Impressions | Position | Opportunity",
    "--- | --- | ---: | ---: | ---:",
    ...opportunities.map((item) => `${tableCell(item.keys[0] ?? "")} | ${tableCell(item.keys[1] ?? "")} | ${item.impressions} | ${item.position.toFixed(2)} | ${item.opportunity.toFixed(0)}`),
  ];
  if (opportunities.length === 0) lines.push("No opportunities found.");
  return result(lines.join("\n"), { siteUrl: params.siteUrl, window, opportunities });
}

export async function compareSearchPeriods(clients: GoogleClients, params: CompareSearchPeriodsParams, now = new Date()): Promise<ToolResult> {
  const currentWindow = analysisWindow(params, now);
  const previousWindow = precedingWindow(currentWindow);
  const dimensions = [params.by];
  const current = await fetchInsightRows(clients, params.siteUrl, insightRequest(currentWindow, dimensions));
  const previous = await fetchInsightRows(clients, params.siteUrl, insightRequest(previousWindow, dimensions));
  const { gainers, losers } = comparePeriods(current, previous, { limit: params.limit ?? 50 });
  const lines = [
    `Search period comparison for ${params.siteUrl} (${currentWindow.startDate} to ${currentWindow.endDate})`,
    `${params.by} | Click delta | Impression delta | Position delta`,
    "--- | ---: | ---: | ---:",
    ...gainers.map((item) => compareLine(item, "+")),
    ...losers.map((item) => compareLine(item, "")),
  ];
  if (gainers.length === 0 && losers.length === 0) lines.push("No click changes found.");
  return result(lines.join("\n"), { siteUrl: params.siteUrl, currentWindow, previousWindow, gainers, losers });
}

export async function ctrGapsTool(clients: GoogleClients, params: CtrGapsParams, now = new Date()): Promise<ToolResult> {
  const window = analysisWindow(params, now);
  const rows = await fetchInsightRows(clients, params.siteUrl, insightRequest(window, [params.by]));
  const gaps = ctrGaps(rows, { minImpressions: params.minImpressions ?? 100, limit: params.limit ?? 50 });
  const lines = [
    `CTR gaps for ${params.siteUrl} (${window.startDate} to ${window.endDate})`,
    `${params.by} | Impressions | CTR | Expected CTR | Missed clicks`,
    "--- | ---: | ---: | ---: | ---:",
    ...gaps.map((item) => `${tableCell(item.keys[0] ?? "")} | ${item.impressions} | ${(item.ctr * 100).toFixed(2)}% | ${(item.expectedCtr * 100).toFixed(2)}% | ${item.missedClicks}`),
  ];
  if (gaps.length === 0) lines.push("No CTR gaps found.");
  return result(lines.join("\n"), { siteUrl: params.siteUrl, window, gaps });
}

export async function queryCannibalization(clients: GoogleClients, params: QueryCannibalizationParams, now = new Date()): Promise<ToolResult> {
  const window = analysisWindow(params, now);
  const rows = await fetchInsightRows(clients, params.siteUrl, insightRequest(window, ["query", "page"]));
  const groups = cannibalization(rows, { minImpressions: params.minImpressions ?? 10 });
  const lines = [
    `Query cannibalization for ${params.siteUrl} (${window.startDate} to ${window.endDate})`,
    "Query | Competing pages | Total impressions",
    "--- | ---: | ---:",
    ...groups.map((group) => `${tableCell(group.query)} | ${group.pages.length} | ${group.pages.reduce((sum, page) => sum + page.impressions, 0)}`),
  ];
  if (groups.length === 0) lines.push("No competing pages found.");
  return result(lines.join("\n"), { siteUrl: params.siteUrl, window, groups });
}

export async function listProperties(clients: GoogleClients): Promise<ToolResult> {
  const response = await clients.searchConsole.sites.list({});
  const properties = (response.data.siteEntry ?? []).map((site) => ({
    siteUrl: site.siteUrl ?? null,
    permissionLevel: site.permissionLevel ?? null,
  }));
  const lines = [`Search Console properties: ${properties.length}`];
  for (const property of properties) {
    lines.push(`- ${property.siteUrl ?? "(unknown)"} (${property.permissionLevel ?? "unknown"})`);
  }
  if (properties.length === 0) lines.push("No properties. Run `seo-mcp verify <domain>` to add one.");
  return result(lines.join("\n"), { count: properties.length, properties });
}

export async function listSitemaps(clients: GoogleClients, params: ListSitemapsParams): Promise<ToolResult> {
  const response = await clients.searchConsole.sitemaps.list({ siteUrl: params.siteUrl });
  const sitemaps = (response.data.sitemap ?? []).map(shapeSitemap);
  const lines = [`Sitemaps for ${params.siteUrl}: ${sitemaps.length}`];
  for (const sitemap of sitemaps) {
    lines.push(`- ${sitemap.path ?? "(unknown)"}: pending=${String(sitemap.isPending)}, warnings=${sitemap.warnings}, errors=${sitemap.errors}, submitted=${sitemap.lastSubmitted ?? "unknown"}`);
  }
  return result(lines.join("\n"), { siteUrl: params.siteUrl, count: sitemaps.length, sitemaps });
}

export async function submitSitemap(clients: GoogleClients, params: SubmitSitemapParams): Promise<ToolResult> {
  if (params.dryRun) {
    return result(
      `Dry run: would submit ${params.feedpath} to ${params.siteUrl}. No write performed.`,
      { success: true, dryRun: true, siteUrl: params.siteUrl, feedpath: params.feedpath, sitemap: null, stateRefreshError: null },
    );
  }
  await clients.searchConsole.sitemaps.submit({ siteUrl: params.siteUrl, feedpath: params.feedpath });
  let sitemap: Record<string, unknown> | null = null;
  let stateRefreshError: string | null = null;
  try {
    const response = await clients.searchConsole.sitemaps.list({ siteUrl: params.siteUrl });
    const match = response.data.sitemap?.find((item) => item.path === params.feedpath);
    sitemap = match ? shapeSitemap(match) : null;
  } catch (error) {
    stateRefreshError = error instanceof Error ? error.message : String(error);
  }
  return result(
    `Google accepted ${params.feedpath} for ${params.siteUrl}.${sitemap ? ` Current state: pending=${String(sitemap.isPending)}, errors=${sitemap.errors}.` : stateRefreshError ? " The submission succeeded, but its current state could not be refreshed." : " It is not yet present in the sitemap list."}`,
    { success: true, siteUrl: params.siteUrl, feedpath: params.feedpath, sitemap, stateRefreshError },
  );
}

export async function inspectUrl(clients: GoogleClients, params: InspectUrlParams): Promise<ToolResult> {
  const response = await clients.searchConsole.urlInspection.index.inspect({
    requestBody: { siteUrl: params.siteUrl, inspectionUrl: params.inspectionUrl },
  });
  const inspection = response.data.inspectionResult;
  const index = inspection?.indexStatusResult;
  const indexStatus = {
    coverageState: index?.coverageState ?? null,
    verdict: index?.verdict ?? null,
    robotsTxtState: index?.robotsTxtState ?? null,
    indexingState: index?.indexingState ?? null,
    lastCrawlTime: index?.lastCrawlTime ?? null,
    googleCanonical: index?.googleCanonical ?? null,
    userCanonical: index?.userCanonical ?? null,
    pageFetchState: index?.pageFetchState ?? null,
  };
  const mobileUsability = inspection?.mobileUsabilityResult ? {
    verdict: inspection.mobileUsabilityResult.verdict ?? null,
    issues: inspection.mobileUsabilityResult.issues ?? [],
  } : null;
  const richResults = inspection?.richResultsResult ? {
    verdict: inspection.richResultsResult.verdict ?? null,
    detectedItems: inspection.richResultsResult.detectedItems ?? [],
  } : null;
  const text = [
    `URL inspection for ${params.inspectionUrl}`,
    `Verdict: ${indexStatus.verdict ?? "unknown"}`,
    `Coverage: ${indexStatus.coverageState ?? "unknown"}`,
    `Indexing: ${indexStatus.indexingState ?? "unknown"}; robots.txt: ${indexStatus.robotsTxtState ?? "unknown"}; fetch: ${indexStatus.pageFetchState ?? "unknown"}`,
    `Canonical: Google=${indexStatus.googleCanonical ?? "unknown"}; user=${indexStatus.userCanonical ?? "unknown"}`,
    `Last crawl: ${indexStatus.lastCrawlTime ?? "unknown"}`,
    `Mobile usability: ${mobileUsability?.verdict ?? "not reported"}`,
    `Rich results: ${richResults?.verdict ?? "not reported"}`,
  ].join("\n");
  return result(text, { siteUrl: params.siteUrl, inspectionUrl: params.inspectionUrl, indexStatus, mobileUsability, richResults });
}

export async function runPageSpeed(clients: GoogleClients, params: PageSpeedParams): Promise<ToolResult> {
  const apiKey = params.apiKey ?? process.env.SEO_MCP_PAGESPEED_KEY;
  const response = await clients.pageSpeed.pagespeedapi.runpagespeed({
    url: params.url,
    strategy: params.strategy,
    category: params.category,
    ...(apiKey ? { key: apiKey } : {}),
  });
  const data = response.data;
  const metrics = data.loadingExperience?.metrics ?? {};
  const fieldData = {
    lcp: fieldMetric(metrics["LARGEST_CONTENTFUL_PAINT_MS"]),
    cls: fieldMetric(metrics["CUMULATIVE_LAYOUT_SHIFT_SCORE"]),
    inp: fieldMetric(metrics["INTERACTION_TO_NEXT_PAINT"]),
    fid: fieldMetric(metrics["FIRST_INPUT_DELAY_MS"]),
    fcp: fieldMetric(metrics["FIRST_CONTENTFUL_PAINT_MS"]),
    ttfb: fieldMetric(metrics["EXPERIMENTAL_TIME_TO_FIRST_BYTE"]),
  };
  const scores = Object.fromEntries(Object.entries(data.lighthouseResult?.categories ?? {})
    .filter((entry): entry is [string, pagespeedonline_v5.Schema$LighthouseCategoryV5] => Boolean(entry[1]))
    .map(([key, category]) => [key, category.score === null || category.score === undefined ? null : Math.round(category.score * 100)]));
  const opportunities = Object.entries(data.lighthouseResult?.audits ?? {})
    .flatMap(([id, audit]) => {
      if (!audit || audit.score === 1 || audit.scoreDisplayMode === "notApplicable") return [];
      const savingsMs = numericDetail(audit.details, "overallSavingsMs") ?? (audit.numericUnit === "millisecond" ? audit.numericValue ?? null : null);
      if (!savingsMs || savingsMs <= 0) return [];
      return [{ id, title: audit.title ?? id, description: audit.description ?? null, savingsMs: Math.round(savingsMs) }];
    })
    .sort((a, b) => b.savingsMs - a.savingsMs)
    .slice(0, 10);
  const presentFieldData = Object.fromEntries(Object.entries(fieldData).filter(([, value]) => value !== null));
  const text = [
    `PageSpeed Insights for ${params.url} (${params.strategy})`,
    `Lab scores: ${Object.entries(scores).map(([name, score]) => `${name}=${score ?? "n/a"}`).join(", ") || "not reported"}`,
    `Field data: ${Object.entries(presentFieldData).map(([name, metric]) => `${name.toUpperCase()}=${metric?.value} (${metric?.category ?? "unknown"})`).join(", ") || "not available"}`,
    "Top opportunities:",
    ...(opportunities.length ? opportunities.map((item) => `- ${item.title}: about ${item.savingsMs} ms`) : ["- None reported"]),
  ].join("\n");
  return result(text, { url: params.url, strategy: params.strategy, fieldData: presentFieldData, scores, opportunities });
}

function shapeSitemap(sitemap: searchconsole_v1.Schema$WmxSitemap): Record<string, unknown> {
  return {
    path: sitemap.path ?? null,
    lastSubmitted: sitemap.lastSubmitted ?? null,
    lastDownloaded: sitemap.lastDownloaded ?? null,
    isPending: sitemap.isPending ?? false,
    isSitemapsIndex: sitemap.isSitemapsIndex ?? false,
    warnings: toNumber(sitemap.warnings),
    errors: toNumber(sitemap.errors),
    contents: (sitemap.contents ?? []).map((content) => ({
      type: content.type ?? null,
      submitted: toNumber(content.submitted),
      indexed: toNumber(content.indexed),
    })),
  };
}

function toNumber(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fieldMetric(metric: pagespeedonline_v5.Schema$UserPageLoadMetricV5 | undefined): { value: number | null; category: string | null } | null {
  return metric ? { value: metric.percentile ?? null, category: metric.category ?? null } : null;
}

function numericDetail(details: unknown, key: string): number | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

type AnalysisWindow = { startDate: string; endDate: string };

function analysisWindow(params: { startDate?: string | undefined; endDate?: string | undefined }, now: Date): AnalysisWindow {
  const endDate = params.endDate ?? formatDate(now);
  const defaultStart = new Date(`${endDate}T00:00:00Z`);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 27);
  const startDate = params.startDate ?? formatDate(defaultStart);
  if (startDate > endDate) throw new Error("startDate must be on or before endDate");
  return { startDate, endDate };
}

function precedingWindow(window: AnalysisWindow): AnalysisWindow {
  const currentStart = new Date(`${window.startDate}T00:00:00Z`);
  const currentEnd = new Date(`${window.endDate}T00:00:00Z`);
  const length = Math.round((currentEnd.valueOf() - currentStart.valueOf()) / 86_400_000) + 1;
  const previousEnd = new Date(currentStart);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - length + 1);
  return { startDate: formatDate(previousStart), endDate: formatDate(previousEnd) };
}

function insightRequest(window: AnalysisWindow, dimensions: string[]): searchconsole_v1.Schema$SearchAnalyticsQueryRequest {
  return { ...window, dimensions, rowLimit: 5000 };
}

async function fetchInsightRows(
  clients: GoogleClients,
  siteUrl: string,
  requestBody: searchconsole_v1.Schema$SearchAnalyticsQueryRequest,
): Promise<InsightRow[]> {
  const response = await clients.searchConsole.searchanalytics.query({ siteUrl, requestBody });
  return (response.data.rows ?? []).map((row) => ({
    keys: row.keys ?? [],
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

function compareLine(item: { keys: string[]; clicksDelta: number; impressionsDelta: number; positionDelta: number }, positivePrefix: string): string {
  return `${tableCell(item.keys[0] ?? "")} | ${positivePrefix}${item.clicksDelta} | ${item.impressionsDelta} | ${item.positionDelta.toFixed(2)}`;
}

function result(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
