import { z } from "zod";
import {
  appStoreListingOutput,
  appStoreListingShape,
  appStoreDiscoveryOutput,
  appStoreDiscoveryShape,
  appStoreReviewsOutput,
  appStoreReviewsShape,
  appStoreSalesOutput,
  appStoreSalesShape,
  compareSnapshotsOutput,
  compareSnapshotsShape,
  cruxFieldDataOutput,
  cruxFieldDataShape,
  cruxHistoryOutput,
  cruxHistoryShape,
  adsCampaignsOutput,
  adsCampaignsShape,
  adsKeywordsOutput,
  adsKeywordsShape,
  adsAdsOutput,
  adsAdsShape,
  adsQueryOutput,
  adsQueryShape,
  adsUpdateOutput,
  adsUpdateShape,
  adsUpdateBatchOutput,
  adsUpdateBatchShape,
  adsKeywordCreateOutput,
  adsKeywordCreateShape,
  adsAdCopyOutput,
  adsAdCopyShape,
  adsAssetsOutput,
  adsAssetsShape,
  adsSearchTermsOutput,
  adsSearchTermsShape,
  adsChangesOutput,
  adsChangesShape,
  adsNegativesOutput,
  adsNegativesShape,
  adsNegativesUpdateOutput,
  adsNegativesUpdateShape,
  listSnapshotsOutput,
  listSnapshotsShape,
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
  playVitalsOutput,
  playVitalsShape,
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
  serverVersionOutput,
  serverVersionShape,
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
import { appStoreSales } from "./app-store-sales.js";
import { compareSnapshots } from "./compare-snapshots.js";
import { cruxFieldData, cruxHistory } from "./crux.js";
import {
  adsCampaigns,
  adsKeywords,
  adsAds,
  adsQuery,
  adsUpdate,
  adsSearchTerms,
  adsChanges,
  adsNegatives,
  adsNegativesUpdateTool,
  adsUpdateBatchTool,
  adsAdCopyTool,
  adsAssetsTool,
  adsKeywordCreateTool,
} from "./google-ads-tools.js";
import { serverVersion } from "./server-version.js";
import { listSnapshotsTool } from "./list-snapshots.js";
import { snapshot } from "./snapshot.js";
import { auditSite } from "./audit-site.js";
import { fetchHtml } from "./fetch-page.js";
import { submitIndexNow } from "./indexnow.js";
import { keywordIdeas } from "./keyword-ideas.js";
import { parseSeoHtml } from "./seo-audit.js";
import { playStoreStats } from "./play-store-stats.js";
import { playVitals } from "./play-vitals.js";
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
  // A write that costs money every hour it is wrong. Resubmitting a sitemap and
  // tripling a daily budget are both writes, and one flag authorising both is
  // not a gate, so these need their own.
  spendsMoney?: boolean;
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
  spendsMoney: boolean;
  run(ctx: ToolContext, params: unknown): Promise<ToolResult>;
}

function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    inputShape: spec.inputShape,
    outputSchema: spec.outputSchema,
    write: spec.write ?? false,
    spendsMoney: spec.spendsMoney ?? false,
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
    run: (ctx, params) =>
      keywordIdeas(params, {
        ...(ctx.keywordIdeasFetchImpl ? { fetchImpl: ctx.keywordIdeasFetchImpl } : {}),
        ...(params.siteUrl
          ? {
              fetchGscRows: async (request) => {
                const response = await ctx.getAuthenticatedClients().searchConsole.searchanalytics.query(request);
                return response.data.rows ?? [];
              },
            }
          : {}),
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
    description:
      "Submit changed URLs in bulk to IndexNow search engines: Bing, Yandex, Naver, Seznam, Yep; not Google. Needs an IndexNow key hosted on the site at https://<host>/<key>.txt (write; supports dryRun)",
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
    description:
      "Audit the on-page SEO of up to N pages from a sitemap and roll up the most common issues across the site. Takes a sitemap URL rather than a Search Console property, and needs no Google credentials",
    inputShape: auditSiteShape,
    outputSchema: auditSiteOutput,
    run: async (_ctx, params) => {
      const result = await auditSite(params.sitemapUrl, params);
      return { content: [{ type: "text", text: formatSiteAudit(result) }], structuredContent: { ...result } };
    },
  }),
  defineTool({
    name: "server_version",
    description:
      "Report which build of this server is answering, where it is running from, and whether it came out of an npx cache. Four values look like this one and are not: what npm calls latest, what the version range resolves to, what the plugin manifest declares, and what is actually running. Checking the command-line tool is not a substitute, since it is a separate process resolved separately. No credentials needed; read-only",
    inputShape: serverVersionShape,
    outputSchema: serverVersionOutput,
    run: (_ctx, params) => serverVersion(params),
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
    description:
      "Read Google Play bulk reports for an app: active device installs and store-listing visitors and acquisitions by traffic source. installsDimension picks which installs breakdown is read (overview, country, language, device, os_version, carrier or app_version), include adds the ratings, crashes and reviews report families, and startDate with endDate reads every month the window touches instead of the single month in month. Reads the reporting bucket named by SEO_MCP_PLAY_BUCKET; read-only",
    inputShape: playStoreStatsShape,
    outputSchema: playStoreStatsOutput,
    run: (_ctx, params) => playStoreStats(params),
  }),
  defineTool({
    name: "app_store_listing",
    description:
      "Read an App Store listing's indexed fields per locale (name, subtitle, keywords) against Apple's character limits, plus promotional text, version state and star ratings. The ratings come from the public storefront lookup because App Store Connect exposes no aggregate rating; each entry names its source. Needs SEO_MCP_ASC_KEY_PATH, SEO_MCP_ASC_KEY_ID and SEO_MCP_ASC_ISSUER_ID; read-only",
    inputShape: appStoreListingShape,
    outputSchema: appStoreListingOutput,
    run: (_ctx, params) => appStoreListing(params),
  }),
  defineTool({
    name: "app_store_sales",
    description:
      "Read App Store Sales and Trends: units downloaded per day per territory per app, summarized by SKU. Needs SEO_MCP_ASC_VENDOR_NUMBER and a team key with Admin, Finance or Sales and Reports. A period with no sales is reported as an absence rather than an error. Read-only",
    inputShape: appStoreSalesShape,
    outputSchema: appStoreSalesOutput,
    run: (_ctx, params) => appStoreSales(params),
  }),
  defineTool({
    name: "play_vitals",
    description:
      "Read Android vitals from the Play Developer Reporting API: crash rate, ANR rate, error counts and startup metrics, daily or hourly, with optional breakdowns. Reports how fresh the data actually is. Carries no acquisition or conversion data; use play_store_stats for that. Read-only",
    inputShape: playVitalsShape,
    outputSchema: playVitalsOutput,
    run: (_ctx, params) => playVitals(params),
  }),
  defineTool({
    name: "app_store_discovery",
    description:
      "Read the App Store surfaces beyond the listing text: search keywords, app tags, product page optimization experiments, custom product pages, in-app events, territory availability and review summarizations. A resource this key cannot read is reported as unavailable rather than as empty. Read-only",
    inputShape: appStoreDiscoveryShape,
    outputSchema: appStoreDiscoveryOutput,
    run: (_ctx, params) => appStoreDiscovery(params),
  }),
  defineTool({
    name: "app_store_reviews",
    description:
      "Read App Store customer reviews and your responses, filtered by rating or storefront. Reports the mean and star split of the reviews actually fetched, which is not the app's lifetime rating; App Store Connect exposes no aggregate rating resource. Read-only",
    inputShape: appStoreReviewsShape,
    outputSchema: appStoreReviewsOutput,
    run: (_ctx, params) => appStoreReviews(params),
  }),
  defineTool({
    name: "crux_field_data",
    description:
      "Read real-user Core Web Vitals for an origin or URL from the Chrome UX Report: the current 28-day field record with p75s and histograms. Field data, not a lab test; PageSpeed's own field block is being discontinued. Needs SEO_MCP_CRUX_KEY or a PageSpeed key allowed to call the Chrome UX Report API; read-only",
    inputShape: cruxFieldDataShape,
    outputSchema: cruxFieldDataOutput,
    run: (_ctx, params) => cruxFieldData(params),
  }),
  defineTool({
    name: "crux_history",
    description:
      "Read the Chrome UX Report weekly history for an origin or URL, roughly six months of 28-day rolling windows, so a field metric can be seen trending rather than as one point. Read-only",
    inputShape: cruxHistoryShape,
    outputSchema: cruxHistoryOutput,
    run: (_ctx, params) => cruxHistory(params),
  }),
  defineTool({
    name: "ads_campaigns",
    description:
      "Read Google Ads campaigns: status, daily budget, impressions, clicks, cost and conversions over a window. Needs GOOGLE_ADS_DEVELOPER_TOKEN, an OAuth client and a refresh token; read-only",
    inputShape: adsCampaignsShape,
    outputSchema: adsCampaignsOutput,
    run: (_ctx, params) => adsCampaigns(params),
  }),
  defineTool({
    name: "ads_keywords",
    description:
      "Read every Google Ads keyword with its effective CPC bid, approval and serving status, and metrics. Returns every row rather than a first page, which is how a count taken from the console goes wrong; read-only",
    inputShape: adsKeywordsShape,
    outputSchema: adsKeywordsOutput,
    run: (_ctx, params) => adsKeywords(params),
  }),
  defineTool({
    name: "ads_ads",
    description: "Read Google Ads ads with ad strength, policy approval status, serving status and metrics; read-only",
    inputShape: adsAdsShape,
    outputSchema: adsAdsOutput,
    run: (_ctx, params) => adsAds(params),
  }),
  defineTool({
    name: "ads_ad_copy",
    description:
      "Read what a Google Ads ad actually says: every headline and description with its pinning and Google's performance label, the display path, the final URLs, and the policy topics behind a limited or disapproved status rather than only the status word. Also reports headline text shared by more than one ad, since two ads in an ad group with the same headlines are not testing anything against each other. Assets such as sitelinks and promotions are not read here; read-only",
    inputShape: adsAdCopyShape,
    outputSchema: adsAdCopyOutput,
    run: (_ctx, params) => adsAdCopyTool(params),
  }),
  defineTool({
    name: "ads_assets",
    description:
      "Read the sitelinks, callouts, structured snippets, promotions, prices, call and image assets attached to the account, its campaigns and its ad groups, with what each one actually says rather than only its type and id. An account-level asset applies to every campaign, so it is listed even when one campaign is named: an ad that looks bare in ads_ad_copy may be serving with these beside it. Attached is not shown, and a level that cannot be read is reported as an error in place rather than as nothing attached; read-only",
    inputShape: adsAssetsShape,
    outputSchema: adsAssetsOutput,
    run: (_ctx, params) => adsAssetsTool(params),
  }),
  defineTool({
    name: "ads_query",
    description:
      "Run an arbitrary GAQL SELECT against the Google Ads account for a question the shaped reads do not cover. GAQL has no statement other than SELECT, so this cannot change anything; read-only",
    inputShape: adsQueryShape,
    outputSchema: adsQueryOutput,
    run: (_ctx, params) => adsQuery(params),
  }),
  defineTool({
    name: "ads_search_terms",
    description:
      "Read the queries that actually triggered an ad, with the keyword each one matched and its metrics. This is the paid equivalent of the Search Console query dimension. Google withholds terms too few people searched, so an absent term is unknown rather than absent; read-only",
    inputShape: adsSearchTermsShape,
    outputSchema: adsSearchTermsOutput,
    run: (_ctx, params) => adsSearchTerms(params),
  }),
  defineTool({
    name: "ads_negatives",
    description:
      "Read the negative keywords already in place, at campaign, ad group or shared-set level. A negative blocks traffic without leaving any record that it did, so this is what to check when a keyword stops serving and nothing looks wrong, and what to check before adding a term twice; read-only",
    inputShape: adsNegativesShape,
    outputSchema: adsNegativesOutput,
    run: (_ctx, params) => adsNegatives(params),
  }),
  defineTool({
    name: "ads_changes",
    description:
      "Read the Google Ads change history: what changed, when, which fields, by whom, and whether it came from a tool or from someone in the browser. Google keeps 30 days and at most 10,000 rows, so an empty result over a longer window is a limit rather than a finding. Filter on resourceType rather than on changed field names: a budget change reports amountMicros and says neither budget nor status. This is the audit trail for anything ads_update writes; read-only",
    inputShape: adsChangesShape,
    outputSchema: adsChangesOutput,
    run: (_ctx, params) => adsChanges(params),
  }),
  defineTool({
    name: "ads_negatives_update",
    description:
      "Add or remove negative keywords in a batch, enumerated one by one with no pattern form. Before adding, every proposed negative is checked against the campaign's own live keywords and the batch is refused if one would block traffic, because a wrong negative leaves no evidence anywhere: the traffic just stops. Dry run unless dryRun is false, and the terms are read back afterwards",
    inputShape: adsNegativesUpdateShape,
    outputSchema: adsNegativesUpdateOutput,
    write: true,
    spendsMoney: true,
    run: (_ctx, params) => adsNegativesUpdateTool(params),
  }),
  defineTool({
    name: "ads_update",
    description:
      "Change one Google Ads keyword bid, campaign daily budget, campaign status, ad status or keyword status. Pausing one keyword is its own kind because dropping a bid is not the same thing: the keyword stays eligible and goes on competing for the same budget. Spends money, so it is a dry run unless dryRun is false, it refuses a change that trips a guard unless confirm is true, and it re-reads the value after writing because an accepted request is not a stored value. Guards: more than three times the current amount, more than $25, or pausing something that is serving",
    inputShape: adsUpdateShape,
    outputSchema: adsUpdateOutput,
    write: true,
    spendsMoney: true,
    run: (_ctx, params) => adsUpdate(params),
  }),
  defineTool({
    name: "ads_keyword_create",
    description:
      "Add one keyword to an ad group. This is the only tool here that creates rather than changes, and it is guarded differently for that reason: there is no current value to compare against, so it is a duplicate check instead. It refuses a keyword that already exists in the target ad group, including a removed one, since a removed criterion still holds the text and Google rejects the create with an error naming a resource the interface does not show. A copy elsewhere in the account trips a guard rather than refusing, because two copies compete for the same budget. EXACT by default; PHRASE and BROAD buy more than the text written and each trips a guard. Dry run unless dryRun is false, and the keyword is read back afterwards",
    inputShape: adsKeywordCreateShape,
    outputSchema: adsKeywordCreateOutput,
    write: true,
    spendsMoney: true,
    run: (_ctx, params) => adsKeywordCreateTool(params),
  }),
  defineTool({
    name: "ads_update_batch",
    description:
      "Change several Google Ads keyword bids, or several campaign daily budgets, in one call. It is a named list of pairs, not a rule applied to many things: each entry names one target and the value it should end at, and an entry that matches no row or more than one refuses the whole batch before anything is written. The sum is guarded as well as each entry, because separately reasonable raises are one large spend change together. Dry run unless dryRun is false, and every value is read back afterwards",
    inputShape: adsUpdateBatchShape,
    outputSchema: adsUpdateBatchOutput,
    write: true,
    spendsMoney: true,
    run: (_ctx, params) => adsUpdateBatchTool(params),
  }),
  defineTool({
    name: "list_snapshots",
    description:
      "List the snapshot documents already in the snapshot directory, newest first: when each was taken, the window it covers, and how many properties, apps, packages and plugins it holds. This is what says whether there is an earlier snapshot to compare against and what to name as from and to; a file that does not parse is listed with its error rather than hidden; read-only",
    inputShape: listSnapshotsShape,
    outputSchema: listSnapshotsOutput,
    run: (_ctx, params) => listSnapshotsTool(params),
  }),
  defineTool({
    name: "snapshot",
    description:
      "Capture four surfaces in one timestamped document: Search Console totals and top rows per property, App Store listings, Google Play installs and traffic, and WordPress.org stats. Core Web Vitals field data, Android vitals, App Store sales and App Store reviews are not captured. A surface that cannot be read is recorded as an error in place rather than omitted; list_snapshots names the documents already on disk to compare an earlier one against; read-only",
    inputShape: snapshotShape,
    outputSchema: snapshotOutput,
    run: (ctx, params) => snapshot(ctx, params),
  }),
  defineTool({
    name: "compare_snapshots",
    description:
      "Compare two snapshot documents and return the differences between them: clicks, impressions, positions, installs, ratings and locale counts. Reports arithmetic only, never whether a change was good or what caused it; read-only",
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
  const truncation = audit.truncated ? `Truncated: ${audit.skipped} discovered page(s) and ${audit.childSitemapsSkipped} child sitemap(s) skipped` : "Truncated: no";
  const issues = Object.entries(audit.rollup)
    .sort((left, right) => right[1] - left[1])
    .map(([issue, count]) => `- ${issue}: ${count}`);
  return [summary, truncation, "Issue rollup:", ...(issues.length ? issues : ["- No issues found"])].join("\n");
}
