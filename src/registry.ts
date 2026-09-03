import { z } from "zod";
import {
  appStoreListingOutput,
  appStoreListingShape,
  appStoreDiscoveryOutput,
  appStoreDiscoveryShape,
  appStoreReviewsOutput,
  appStoreReviewsShape,
  compareSnapshotsOutput,
  compareSnapshotsShape,
  cruxFieldDataOutput,
  cruxFieldDataShape,
  cruxHistoryOutput,
  cruxHistoryShape,
  snapshotOutput,
  snapshotShape,
  auditSiteOutput,
  auditSiteShape,
  compareSearchPeriodsOutput,
  compareSearchPeriodsShape,
  ctrGapsOutput,
  ctrGapsShape,
  deleteSitemapOutput,
  deleteSitemapShape,
  indexCoverageOutput,
  indexCoverageShape,
  indexNowSubmitOutput,
  indexNowSubmitShape,
  inspectUrlOutput,
  inspectUrlShape,
  keywordIdeasOutput,
  keywordIdeasShape,
  listPropertiesOutput,
  listPropertiesShape,
  playStoreStatsOutput,
  playStoreStatsShape,
  listSitemapsOutput,
  listSitemapsShape,
  pageSpeedOutput,
  pageSpeedShape,
  queryCannibalizationOutput,
  queryCannibalizationShape,
  requestRecrawlOutput,
  requestRecrawlShape,
  searchAnalyticsOutput,
  searchAnalyticsShape,
  searchOpportunitiesOutput,
  searchOpportunitiesShape,
  seoAuditOutput,
  seoAuditShape,
  submitSitemapOutput,
  submitSitemapShape,
  wporgPluginOutput,
  wporgPluginShape,
} from "./schemas.js";
import {
  compareSearchPeriods,
  createGoogleClients,
  ctrGapsTool,
  deleteSitemap,
  indexCoverage,
  inspectUrl,
  listProperties,
  listSitemaps,
  queryCannibalization,
  requestRecrawl,
  runPageSpeed,
  searchAnalytics,
  searchOpportunities,
  submitSitemap,
  type GoogleClients,
  type ToolResult,
} from "./google-tools.js";
import { validateCredentials } from "./credentials.js";
import { appStoreListing } from "./app-store-listing.js";
import { appStoreReviews } from "./app-store-reviews.js";
import { appStoreDiscovery } from "./app-store-discovery.js";
import { compareSnapshots } from "./compare-snapshots.js";
import { cruxFieldData, cruxHistory } from "./crux.js";
import { snapshot } from "./snapshot.js";
import { auditSite } from "./audit-site.js";
import { fetchHtml } from "./fetch-page.js";
import { submitIndexNow } from "./indexnow.js";
import { keywordIdeas } from "./keyword-ideas.js";
import { parseSeoHtml } from "./seo-audit.js";
import { playStoreStats } from "./play-store-stats.js";
import { wporgPlugin } from "./wporg.js";

// A tool's logic lives in one place and is reached identically by the MCP server
// and the `query` CLI. The context supplies clients lazily so tools that need no
// credentials (seo_audit, pagespeed, indexnow_submit, wporg_plugin, keyword_ideas
// without a siteUrl) run without any being configured.
export interface ToolContext {
  getClients(): GoogleClients;
  getAuthenticatedClients(): GoogleClients;
  keywordIdeasFetchImpl?: typeof fetch;
}

export interface ToolContextDeps {
  credentialsPath?: string;
  clients?: GoogleClients;
  keywordIdeasFetchImpl?: typeof fetch;
}

export function createToolContext(deps: ToolContextDeps): ToolContext {
  let clients = deps.clients;
  const getClients = (): GoogleClients => (clients ??= createGoogleClients(deps.credentialsPath));
  const getAuthenticatedClients = (): GoogleClients => {
    if (!deps.clients) validateCredentials(deps.credentialsPath);
    return getClients();
  };
  return {
    getClients,
    getAuthenticatedClients,
    ...(deps.keywordIdeasFetchImpl ? { keywordIdeasFetchImpl: deps.keywordIdeasFetchImpl } : {}),
  };
}

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  description: string;
  inputShape: Shape;
  outputSchema: z.ZodType;
  // Tools that change something outside this process. Over MCP a person is
  // watching the call; from a shell these are one line in a cron job, so the
  // query command makes them opt in.
  write?: boolean;
  run(ctx: ToolContext, params: z.infer<z.ZodObject<Shape>>): Promise<ToolResult>;
}

// Params reach `run` already parsed: the MCP SDK parses against inputShape before
// calling the handler, and the CLI parses in runQuery. So run never re-parses,
// which keeps input transforms (e.g. the siteUrl normalizer) from running twice.
export interface ToolDefinition {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  outputSchema: z.ZodType;
  write: boolean;
  run(ctx: ToolContext, params: unknown): Promise<ToolResult>;
}

function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    inputShape: spec.inputShape,
    outputSchema: spec.outputSchema,
    write: spec.write ?? false,
    run: (ctx, params) => spec.run(ctx, params as z.infer<z.ZodObject<Shape>>),
  };
}

export const toolDefinitions: ToolDefinition[] = [
  defineTool({
    name: "search_analytics",
    description: "Query Google Search Console search analytics and return ranked clicks, impressions, CTR, and position",
    inputShape: searchAnalyticsShape,
    outputSchema: searchAnalyticsOutput,
    run: (ctx, params) => searchAnalytics(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "keyword_ideas",
    description: "Expand a seed with free Google Autocomplete suggestions and optionally cross-reference Search Console rankings; no extra API key needed",
    inputShape: keywordIdeasShape,
    outputSchema: keywordIdeasOutput,
    run: (ctx, params) => keywordIdeas(params, {
      ...(ctx.keywordIdeasFetchImpl ? { fetchImpl: ctx.keywordIdeasFetchImpl } : {}),
      ...(params.siteUrl ? {
        fetchGscRows: async (request) => {
          const response = await ctx.getAuthenticatedClients().searchConsole.searchanalytics.query(request);
          return response.data.rows ?? [];
        },
      } : {}),
    }),
  }),
  defineTool({
    name: "search_opportunities",
    description: "Find queries ranking just off page 1 with high impressions, the highest-ROI keywords to improve",
    inputShape: searchOpportunitiesShape,
    outputSchema: searchOpportunitiesOutput,
    run: (ctx, params) => searchOpportunities(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "compare_search_periods",
    description: "Compare an analysis window with the preceding equal period to identify search gainers and losers",
    inputShape: compareSearchPeriodsShape,
    outputSchema: compareSearchPeriodsOutput,
    run: (ctx, params) => compareSearchPeriods(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "ctr_gaps",
    description: "Find high-impression queries or pages whose CTR trails peers at the same position for snippet rewrite prioritization",
    inputShape: ctrGapsShape,
    outputSchema: ctrGapsOutput,
    run: (ctx, params) => ctrGapsTool(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "query_cannibalization",
    description: "Find queries served by multiple pages to prioritize consolidation and internal-linking decisions",
    inputShape: queryCannibalizationShape,
    outputSchema: queryCannibalizationOutput,
    run: (ctx, params) => queryCannibalization(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "list_sitemaps",
    description: "List sitemaps submitted for a Google Search Console property",
    inputShape: listSitemapsShape,
    outputSchema: listSitemapsOutput,
    run: (ctx, params) => listSitemaps(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "list_properties",
    description: "List Google Search Console properties the service account can access, with permission levels",
    inputShape: listPropertiesShape,
    outputSchema: listPropertiesOutput,
    run: (ctx) => listProperties(ctx.getAuthenticatedClients()),
  }),
  defineTool({
    name: "submit_sitemap",
    write: true,
    description: "Submit a sitemap to Google Search Console and return its current state",
    inputShape: submitSitemapShape,
    outputSchema: submitSitemapOutput,
    run: (ctx, params) => submitSitemap(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "delete_sitemap",
    write: true,
    description: "Remove a submitted sitemap from a Search Console property (write; supports dryRun)",
    inputShape: deleteSitemapShape,
    outputSchema: deleteSitemapOutput,
    run: (ctx, params) => deleteSitemap(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "inspect_url",
    description: "Inspect a URL's Google index status, canonical selection, mobile usability, and rich results",
    inputShape: inspectUrlShape,
    outputSchema: inspectUrlOutput,
    run: (ctx, params) => inspectUrl(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "index_coverage",
    description: "Check how many of a sitemap's pages are indexed by Google (bounded; respects URL Inspection quota)",
    inputShape: indexCoverageShape,
    outputSchema: indexCoverageOutput,
    run: (ctx, params) => indexCoverage(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "request_recrawl",
    write: true,
    description: "Inspect URLs' Google index status and resubmit the covering sitemap for the ones not indexed, the supported bulk recrawl nudge (write; supports dryRun)",
    inputShape: requestRecrawlShape,
    outputSchema: requestRecrawlOutput,
    run: (ctx, params) => requestRecrawl(ctx.getAuthenticatedClients(), params),
  }),
  defineTool({
    name: "indexnow_submit",
    write: true,
    description: "Submit changed URLs in bulk to IndexNow search engines: Bing, Yandex, Naver, Seznam, Yep; not Google. Needs an IndexNow key hosted on the site at https://<host>/<key>.txt (write; supports dryRun)",
    inputShape: indexNowSubmitShape,
    outputSchema: indexNowSubmitOutput,
    run: (_ctx, params) => submitIndexNow(params),
  }),
  defineTool({
    name: "pagespeed",
    description: "Run PageSpeed Insights for field Core Web Vitals, Lighthouse scores, and top opportunities",
    inputShape: pageSpeedShape,
    outputSchema: pageSpeedOutput,
    run: (ctx, params) => runPageSpeed(ctx.getClients(), params),
  }),
  defineTool({
    name: "seo_audit",
    description: "Fetch and audit a web page's on-page SEO without Google credentials",
    inputShape: seoAuditShape,
    outputSchema: seoAuditOutput,
    run: async (_ctx, params) => {
      const page = await fetchHtml(params.url);
      const audit = parseSeoHtml(page.html, page.finalUrl);
      return { content: [{ type: "text", text: formatAudit(audit) }], structuredContent: { ...audit, httpStatus: page.status } };
    },
  }),
  defineTool({
    name: "audit_site",
    description: "Audit the on-page SEO of up to N pages from a sitemap and roll up the most common issues across the site. Takes a sitemap URL rather than a Search Console property, and needs no Google credentials",
    inputShape: auditSiteShape,
    outputSchema: auditSiteOutput,
    run: async (_ctx, params) => {
      const result = await auditSite(params.sitemapUrl, params);
      return { content: [{ type: "text", text: formatSiteAudit(result) }], structuredContent: { ...result } };
    },
  }),
  defineTool({
    name: "wporg_plugin",
    description: "Look up a WordPress.org plugin's install base, downloads, ratings, and support stats by slug; public API, no credentials or API key needed",
    inputShape: wporgPluginShape,
    outputSchema: wporgPluginOutput,
    run: (_ctx, params) => wporgPlugin(params),
  }),
  defineTool({
    name: "play_store_stats",
    description: "Read Google Play bulk reports for an app: active device installs and store-listing visitors and acquisitions by traffic source. Reads the reporting bucket named by SEO_MCP_PLAY_BUCKET; read-only",
    inputShape: playStoreStatsShape,
    outputSchema: playStoreStatsOutput,
    run: (_ctx, params) => playStoreStats(params),
  }),
  defineTool({
    name: "app_store_listing",
    description: "Read an App Store listing's indexed fields per locale (name, subtitle, keywords) against Apple's character limits, plus promotional text, version state and public ratings. Needs SEO_MCP_ASC_KEY_PATH, SEO_MCP_ASC_KEY_ID and SEO_MCP_ASC_ISSUER_ID; read-only",
    inputShape: appStoreListingShape,
    outputSchema: appStoreListingOutput,
    run: (_ctx, params) => appStoreListing(params),
  }),
  defineTool({
    name: "app_store_discovery",
    description: "Read the App Store surfaces beyond the listing text: search keywords, app tags, product page optimization experiments, custom product pages, in-app events, territory availability and review summarizations. A resource this key cannot read is reported as unavailable rather than as empty. Read-only",
    inputShape: appStoreDiscoveryShape,
    outputSchema: appStoreDiscoveryOutput,
    run: (_ctx, params) => appStoreDiscovery(params),
  }),
  defineTool({
    name: "app_store_reviews",
    description: "Read App Store customer reviews and your responses, filtered by rating or storefront. Reports the mean and star split of the reviews actually fetched, which is not the app's lifetime rating; App Store Connect exposes no aggregate rating resource. Read-only",
    inputShape: appStoreReviewsShape,
    outputSchema: appStoreReviewsOutput,
    run: (_ctx, params) => appStoreReviews(params),
  }),
  defineTool({
    name: "crux_field_data",
    description: "Read real-user Core Web Vitals for an origin or URL from the Chrome UX Report: the current 28-day field record with p75s and histograms. Field data, not a lab test; PageSpeed's own field block is being discontinued. Needs SEO_MCP_CRUX_KEY or a PageSpeed key allowed to call the Chrome UX Report API; read-only",
    inputShape: cruxFieldDataShape,
    outputSchema: cruxFieldDataOutput,
    run: (_ctx, params) => cruxFieldData(params),
  }),
  defineTool({
    name: "crux_history",
    description: "Read the Chrome UX Report weekly history for an origin or URL, roughly six months of 28-day rolling windows, so a field metric can be seen trending rather than as one point. Read-only",
    inputShape: cruxHistoryShape,
    outputSchema: cruxHistoryOutput,
    run: (_ctx, params) => cruxHistory(params),
  }),
  defineTool({
    name: "snapshot",
    description: "Capture every surface in one timestamped document: Search Console totals and top rows per property, App Store listings, Google Play installs and traffic, and WordPress.org stats. A surface that cannot be read is recorded as an error in place rather than omitted; read-only",
    inputShape: snapshotShape,
    outputSchema: snapshotOutput,
    run: (ctx, params) => snapshot(ctx, params),
  }),
  defineTool({
    name: "compare_snapshots",
    description: "Compare two snapshot documents and return the differences between them: clicks, impressions, positions, installs, ratings and locale counts. Reports arithmetic only, never whether a change was good or what caused it; read-only",
    inputShape: compareSnapshotsShape,
    outputSchema: compareSnapshotsOutput,
    run: (_ctx, params) => compareSnapshots(params),
  }),
];

function formatAudit(audit: ReturnType<typeof parseSeoHtml>): string {
  return [
    `SEO audit for ${audit.url}`,
    `Title: ${audit.title.text ?? "missing"} (${audit.title.length} characters, ${audit.title.count} element(s))`,
    `Meta description: ${audit.metaDescription.text ?? "missing"} (${audit.metaDescription.length} characters)`,
    `Canonical: ${audit.canonical ?? "missing"}`,
    `H1: ${audit.h1.count} (${audit.h1.texts.join(" | ") || "missing"})`,
    `Schema types: ${audit.schemaTypes.join(", ") || "none"}`,
    `Images with alt: ${audit.images.withAlt}/${audit.images.count} (${audit.images.altPercentage}%)`,
    `Links: ${audit.links.internal} internal, ${audit.links.external} external`,
    `Words: ${audit.wordCount}; lang: ${audit.lang ?? "missing"}; viewport: ${audit.viewport ? "present" : "missing"}`,
    "Issues:",
    ...(audit.issues.length ? audit.issues.map((issue) => `- ${issue}`) : ["- None of the checked common issues found"]),
  ].join("\n");
}

function formatSiteAudit(audit: Awaited<ReturnType<typeof auditSite>>): string {
  const summary = `Audited ${audit.audited} of ${audit.totalDiscovered} discovered pages; ${audit.failed} failed`;
  const truncation = audit.truncated
    ? `Truncated: ${audit.skipped} discovered page(s) and ${audit.childSitemapsSkipped} child sitemap(s) skipped`
    : "Truncated: no";
  const issues = Object.entries(audit.rollup)
    .sort((left, right) => right[1] - left[1])
    .map(([issue, count]) => `- ${issue}: ${count}`);
  return [summary, truncation, "Issue rollup:", ...(issues.length ? issues : ["- No issues found"])].join("\n");
}
