import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type {
  adsCampaignsInput,
  adsKeywordsInput,
  adsAdsInput,
  adsQueryInput,
  adsUpdateInput,
  adsSearchTermsInput,
  adsChangesInput,
  adsNegativesInput,
  adsNegativesUpdateInput,
  adsUpdateBatchInput,
  adsAdCopyInput,
  adsAssetsInput,
  adsKeywordCreateInput,
} from "./schemas.js";
import { adsNegativesUpdate } from "./google-ads-negatives.js";
import { adsUpdateBatch } from "./google-ads-batch.js";
import { adsAdCopy } from "./google-ads-copy.js";
import { adsAssets } from "./google-ads-assets.js";
import { adsKeywordCreate } from "./google-ads-create.js";
import { createAdsClient, resolveAdsCredentials, quoteGaql, duringWindow, dateRange, money, moneyOrNull, toMicros, type AdsClient, type AdsDeps } from "./google-ads.js";

type CampaignsParams = z.output<typeof adsCampaignsInput>;
type KeywordsParams = z.output<typeof adsKeywordsInput>;
type AdsParams = z.output<typeof adsAdsInput>;
type QueryParams = z.output<typeof adsQueryInput>;
type UpdateParams = z.output<typeof adsUpdateInput>;
type SearchTermsParams = z.output<typeof adsSearchTermsInput>;
type ChangesParams = z.output<typeof adsChangesInput>;
type NegativesParams = z.output<typeof adsNegativesInput>;
type NegativesUpdateParams = z.output<typeof adsNegativesUpdateInput>;
type UpdateBatchParams = z.output<typeof adsUpdateBatchInput>;
type AdCopyParams = z.output<typeof adsAdCopyInput>;
type AssetsParams = z.output<typeof adsAssetsInput>;
type KeywordCreateParams = z.output<typeof adsKeywordCreateInput>;

// Deliberately low, because they are a fraction of the account they guard rather
// than a round number. A ceiling that is large next to the budget it protects
// stops nothing.
const MAX_SINGLE_AMOUNT = 25;
const MULTIPLE_LIMIT = 3;
const DAYS_PER_MONTH = 30.4;

function client(deps: AdsDeps): AdsClient {
  return deps.credentials ? createAdsClient(deps.credentials, deps.fetchImpl ?? fetch) : createAdsClient(resolveAdsCredentials(deps.env ?? process.env), deps.fetchImpl ?? fetch);
}

function result(text: string, structuredContent: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: "text", text }], structuredContent, ...(isError ? { isError: true } : {}) };
}

// status, budget, bid, ad strength and approval are the value RIGHT NOW. Google
// stores no history for them, so a date-filtered query staples today's setting
// onto an old day's metrics: a campaign paused this morning reports PAUSED
// beside the impressions it served last month. The metrics are of the window;
// these are not, and only saying so keeps the two apart.
function currentStateNote(fields: string[]): string {
  return `${fields.join(", ")} are the value now, not the value during the window. Google keeps no history for settings, so a setting changed since then is reported at its current value beside metrics that are not. ads_changes has the last 30 days of changes.`;
}

export async function adsCampaigns(params: CampaignsParams, deps: AdsDeps = {}): Promise<ToolResult> {
  const rows = await client(deps).gaql(
    `SELECT campaign.name, campaign.status, campaign_budget.amount_micros,
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
     FROM campaign WHERE ${duringWindow(params.days, deps.now ?? new Date())}`,
  );
  const campaigns = rows.map((row) => ({
    name: String(row.campaign?.name ?? ""),
    status: String(row.campaign?.status ?? ""),
    dailyBudget: moneyOrNull(row.campaignBudget?.amountMicros),
    impressions: Number(row.metrics?.impressions ?? 0),
    clicks: Number(row.metrics?.clicks ?? 0),
    cost: money(row.metrics?.costMicros),
    conversions: Number(row.metrics?.conversions ?? 0),
  }));
  const lines = [
    `Google Ads campaigns over the last ${params.days} day(s)`,
    ...campaigns.map(
      (c) =>
        `- ${c.name} [${c.status}] budget ${c.dailyBudget === null ? "not set" : `$${c.dailyBudget.toFixed(2)}/day`}: ${c.impressions} impressions, ${c.clicks} clicks, $${c.cost.toFixed(2)} spent, ${c.conversions} conversions`,
    ),
  ];
  if (!campaigns.length) lines.push("No campaigns had activity in this window.");
  const notes = [currentStateNote(["status", "dailyBudget"])];
  if (campaigns.some((campaign) => campaign.dailyBudget === null)) {
    notes.push(
      "A budget reported as not set is one Google returned no amount for, which is not the same as a budget of zero. It is reported as null rather than 0 so it cannot be read as a campaign that can never spend.",
    );
  }
  lines.push(...notes);
  return result(lines.join("\n"), { days: params.days, rowCount: campaigns.length, campaigns, notes });
}

export async function adsKeywords(params: KeywordsParams, deps: AdsDeps = {}): Promise<ToolResult> {
  const conditions = [duringWindow(params.days, deps.now ?? new Date())];
  if (params.status) conditions.push(`ad_group_criterion.status = '${params.status}'`);
  const rows = await client(deps).gaql(
    `SELECT ad_group.name, ad_group_criterion.keyword.text,
            ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.status,
            ad_group_criterion.approval_status, ad_group_criterion.system_serving_status,
            metrics.impressions, metrics.clicks, metrics.cost_micros
     FROM keyword_view WHERE ${conditions.join(" AND ")}`,
  );
  const keywords = rows.map((row) => ({
    keyword: String(row.adGroupCriterion?.keyword?.text ?? ""),
    adGroup: String(row.adGroup?.name ?? ""),
    bid: moneyOrNull(row.adGroupCriterion?.effectiveCpcBidMicros),
    status: String(row.adGroupCriterion?.status ?? ""),
    approvalStatus: String(row.adGroupCriterion?.approvalStatus ?? ""),
    servingStatus: String(row.adGroupCriterion?.systemServingStatus ?? ""),
    impressions: Number(row.metrics?.impressions ?? 0),
    clicks: Number(row.metrics?.clicks ?? 0),
    cost: money(row.metrics?.costMicros),
  }));
  // The console's keyword table pages at ten rows, which is how a count taken
  // from it can be wrong without looking wrong. This returns every row.
  const lines = [
    `${keywords.length} keyword(s) over the last ${params.days} day(s), every row, not a first page`,
    ...keywords.map(
      (k) =>
        `- ${k.keyword} (${k.adGroup}) ${k.status || "state unknown"} bid ${k.bid === null ? "not set" : `$${k.bid.toFixed(2)}`} ${k.servingStatus}: ${k.impressions} impressions, ${k.clicks} clicks`,
    ),
  ];
  if (!keywords.length) lines.push("No keywords had activity in this window.");
  const notes = [currentStateNote(["status", "bid", "approvalStatus", "servingStatus"])];
  if (keywords.some((keyword) => keyword.bid === null)) {
    notes.push(
      "A bid reported as not set is one Google returned no amount for, which is what a keyword under an automated bidding strategy looks like: the strategy sets the price per auction and there is no CPC bid to read. It is null rather than 0 so it cannot be read as a bid of zero.",
    );
  }
  // ELIGIBLE is the word that does the damage. It means approved and capable of
  // serving, not currently serving, so a paused keyword reads ELIGIBLE and its
  // row is otherwise identical to a live one. Someone who paused three keywords
  // and sees them here unchanged concludes the pause did not take.
  const paused = keywords.filter((keyword) => keyword.status === "PAUSED");
  if (paused.length) {
    notes.push(
      `${paused.length} of these ${keywords.length} keyword(s) are PAUSED and are not serving: ${paused.map((keyword) => keyword.keyword).join(", ")}. They still report an ELIGIBLE serving status, which means approved and capable of serving rather than currently serving, and they still carry the impressions they earned before they were paused.`,
    );
  }
  lines.push(...notes);
  return result(lines.join("\n"), { days: params.days, rowCount: keywords.length, keywords, notes });
}

export async function adsAds(params: AdsParams, deps: AdsDeps = {}): Promise<ToolResult> {
  const rows = await client(deps).gaql(
    `SELECT ad_group.name, ad_group_ad.ad.id, ad_group_ad.status,
            ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status,
            metrics.impressions, metrics.clicks
     FROM ad_group_ad WHERE ${duringWindow(params.days, deps.now ?? new Date())}`,
  );
  const ads = rows.map((row) => ({
    adId: String(row.adGroupAd?.ad?.id ?? ""),
    adGroup: String(row.adGroup?.name ?? ""),
    status: String(row.adGroupAd?.status ?? ""),
    adStrength: String(row.adGroupAd?.adStrength ?? ""),
    approvalStatus: String(row.adGroupAd?.policySummary?.approvalStatus ?? ""),
    impressions: Number(row.metrics?.impressions ?? 0),
    clicks: Number(row.metrics?.clicks ?? 0),
  }));
  const lines = [
    `${ads.length} ad(s) over the last ${params.days} day(s)`,
    ...ads.map((a) => `- ${a.adId} (${a.adGroup}) ${a.status}, strength ${a.adStrength || "unknown"}, ${a.approvalStatus || "unknown"}: ${a.impressions} impressions`),
  ];
  if (!ads.length) lines.push("No ads had activity in this window.");
  const notes = [currentStateNote(["status", "adStrength", "approvalStatus"])];
  lines.push(...notes);
  return result(lines.join("\n"), { days: params.days, rowCount: ads.length, ads, notes });
}

export async function adsQuery(params: QueryParams, deps: AdsDeps = {}): Promise<ToolResult> {
  // GAQL only selects, so this cannot change anything. It exists because the
  // four shaped reads cannot anticipate every question.
  if (!/^\s*SELECT\s/i.test(params.query)) {
    throw new Error("A Google Ads query must start with SELECT. GAQL has no other statement, and this tool does not mutate.");
  }
  const rows = await client(deps).gaql(params.query);
  return result(`${rows.length} row(s) returned. See structured data.`, { query: params.query, rowCount: rows.length, rows });
}

export async function adsSearchTerms(params: SearchTermsParams, deps: AdsDeps = {}): Promise<ToolResult> {
  const rows = await client(deps).gaql(
    `SELECT search_term_view.search_term, search_term_view.status, campaign.name,
            segments.keyword.info.text, segments.keyword.info.match_type,
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
     FROM search_term_view WHERE ${duringWindow(params.days, deps.now ?? new Date())}`,
  );
  const all = rows.map((row) => ({
    searchTerm: String(row.searchTermView?.searchTerm ?? ""),
    matchedKeyword: String(row.segments?.keyword?.info?.text ?? ""),
    matchType: String(row.segments?.keyword?.info?.matchType ?? ""),
    campaign: String(row.campaign?.name ?? ""),
    status: String(row.searchTermView?.status ?? ""),
    impressions: Number(row.metrics?.impressions ?? 0),
    clicks: Number(row.metrics?.clicks ?? 0),
    cost: money(row.metrics?.costMicros),
    conversions: Number(row.metrics?.conversions ?? 0),
  }));
  const searchTerms = all
    .filter((term) => term.impressions >= params.minImpressions && term.cost >= params.minCost && (!params.zeroConversionsOnly || term.conversions === 0))
    // Cost descending, because the question this list answers is what to stop
    // paying for. Impressions first would put the cheapest noise at the top.
    .sort((left, right) => right.cost - left.cost || right.impressions - left.impressions);

  const notes = [
    "These are the queries that actually triggered an ad, which is the paid equivalent of the Search Console query dimension.",
    // Same withholding shape as Search Console, and the same trap: a term that
    // is not here is not a term nobody searched.
    "Google withholds search terms that too few people searched, so this list is not every query that reached the account and an absent term is unknown rather than absent.",
  ];
  if (all.length !== searchTerms.length) {
    const filters = [
      ...(params.minCost > 0 ? [`cost below $${params.minCost.toFixed(2)}`] : []),
      ...(params.minImpressions > 0 ? [`fewer than ${params.minImpressions} impressions`] : []),
      ...(params.zeroConversionsOnly ? ["at least one conversion"] : []),
    ];
    notes.push(`${all.length - searchTerms.length} term(s) are not listed because of the filters asked for (${filters.join(", ")}).`);
  }

  const lines = [
    `${searchTerms.length} search term(s) over the last ${params.days} day(s), costliest first`,
    ...searchTerms.map(
      (t) =>
        `- ${t.searchTerm} (matched ${t.matchedKeyword || "unknown"}${t.matchType ? `, ${t.matchType}` : ""}): $${t.cost.toFixed(2)}, ${t.impressions} impressions, ${t.clicks} clicks, ${t.conversions} conversions`,
    ),
    ...notes,
  ];
  return result(lines.join("\n"), { days: params.days, rowCount: searchTerms.length, searchTerms, notes });
}

export async function adsNegatives(params: NegativesParams, deps: AdsDeps = {}): Promise<ToolResult> {
  const api = client(deps);
  const wanted = (level: string): boolean => params.level === "all" || params.level === level;
  const negatives: Array<{ level: string; owner: string; keyword: string; matchType: string; criterionId: string }> = [];

  if (wanted("campaign")) {
    for (const row of await api.gaql(
      `SELECT campaign.name, campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
       FROM campaign_criterion WHERE campaign_criterion.negative = true AND campaign_criterion.type = 'KEYWORD'`,
    )) {
      negatives.push({
        level: "campaign",
        owner: String(row.campaign?.name ?? ""),
        keyword: String(row.campaignCriterion?.keyword?.text ?? ""),
        matchType: String(row.campaignCriterion?.keyword?.matchType ?? ""),
        criterionId: String(row.campaignCriterion?.criterionId ?? ""),
      });
    }
  }

  if (wanted("adGroup")) {
    for (const row of await api.gaql(
      `SELECT ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
       FROM ad_group_criterion WHERE ad_group_criterion.negative = true AND ad_group_criterion.type = 'KEYWORD'`,
    )) {
      negatives.push({
        level: "adGroup",
        owner: String(row.adGroup?.name ?? ""),
        keyword: String(row.adGroupCriterion?.keyword?.text ?? ""),
        matchType: String(row.adGroupCriterion?.keyword?.matchType ?? ""),
        criterionId: String(row.adGroupCriterion?.criterionId ?? ""),
      });
    }
  }

  if (wanted("sharedSet")) {
    for (const row of await api.gaql(
      `SELECT shared_set.name, shared_criterion.criterion_id, shared_criterion.keyword.text, shared_criterion.keyword.match_type
       FROM shared_criterion WHERE shared_set.type = 'NEGATIVE_KEYWORDS'`,
    )) {
      negatives.push({
        level: "sharedSet",
        owner: String(row.sharedSet?.name ?? ""),
        keyword: String(row.sharedCriterion?.keyword?.text ?? ""),
        matchType: String(row.sharedCriterion?.keyword?.matchType ?? ""),
        criterionId: String(row.sharedCriterion?.criterionId ?? ""),
      });
    }
  }

  const notes = [
    // A negative that is already there is the reason a term is missing from the
    // search terms report, and nothing else in the surface can see it.
    "A negative keyword blocks traffic without leaving a record anywhere that it did, so this is the list to check when a keyword stops serving and nothing looks wrong.",
  ];
  if (!negatives.length) notes.push("No negative keywords exist at the level asked for. That is an absence of negatives, not a failed read.");

  const lines = [`${negatives.length} negative keyword(s)`, ...negatives.map((n) => `- [${n.level}] ${n.owner}: ${n.keyword}${n.matchType ? ` (${n.matchType})` : ""}`), ...notes];
  return result(lines.join("\n"), { rowCount: negatives.length, negatives, notes });
}

export async function adsChanges(params: ChangesParams, deps: AdsDeps = {}): Promise<ToolResult> {
  const { startDate, endDate } = dateRange(params.days, deps.now ?? new Date());
  // change_event takes a datetime rather than a date, and refuses a query with
  // no LIMIT, so both are part of the contract rather than a preference.
  const rows = await client(deps).gaql(
    `SELECT change_event.change_date_time, change_event.change_resource_type,
            change_event.resource_change_operation, change_event.changed_fields,
            change_event.user_email, change_event.client_type, campaign.name
     FROM change_event
     WHERE change_event.change_date_time BETWEEN '${startDate} 00:00:00' AND '${endDate} 23:59:59'
     ORDER BY change_event.change_date_time DESC
     LIMIT ${params.limit}`,
  );
  const changes = rows.map((row) => ({
    changedAt: String(row.changeEvent?.changeDateTime ?? ""),
    resourceType: String(row.changeEvent?.changeResourceType ?? ""),
    operation: String(row.changeEvent?.resourceChangeOperation ?? ""),
    changedFields: String(row.changeEvent?.changedFields ?? ""),
    userEmail: String(row.changeEvent?.userEmail ?? ""),
    clientType: String(row.changeEvent?.clientType ?? ""),
    campaign: String(row.campaign?.name ?? ""),
  }));
  const notes = [
    "clientType says where a change came from: GOOGLE_ADS_API for a tool, GOOGLE_ADS_WEB_CLIENT for someone in the browser.",
    "Google keeps change history for 30 days, so anything older cannot be recovered here. The related change_status resource keeps 90 days but reports only that a thing changed, not which fields.",
    // The trap is one layer up, in whatever reads this. A budget change reports
    // amountMicros and contains neither "budget" nor "status", so a filter
    // written on the field name matches nothing and the change is invisible,
    // while unrelated rows carrying the searched-for word keep the filter
    // looking alive. Resource type first, field name only to disambiguate.
    "Filter on resourceType, not on changedFields. A campaign budget change reports changedFields amountMicros, which contains neither budget nor status, so a filter looking for either matches nothing and the change goes unseen. resourceType is CAMPAIGN_BUDGET for it and is unambiguous. Use changedFields only to tell apart changes of the same type: an AD_GROUP_CRITERION UPDATE is a bid change when changedFields is cpcBidMicros and a pause when it is status.",
  ];
  if (changes.length === params.limit) {
    notes.push(`Exactly ${params.limit} rows came back, which is the limit asked for, so there may be more. Raise limit or shorten the window.`);
  }
  const lines = [
    `${changes.length} change(s) in the last ${params.days} day(s)`,
    ...changes.map((c) => `- ${c.changedAt} ${c.operation} ${c.resourceType}${c.changedFields ? ` (${c.changedFields})` : ""} by ${c.userEmail || "unknown"} via ${c.clientType}`),
    ...notes,
  ];
  return result(lines.join("\n"), { days: params.days, rowCount: changes.length, changes, notes });
}

interface Plan {
  service: string;
  operations: unknown[];
  before: string;
  after: string;
  beforeAmount: number | null;
  afterAmount: number;
  pausingLive: boolean;
  verify: (client: AdsClient) => Promise<string>;
}

function statusWord(value: string): "PAUSED" | "ENABLED" {
  const word = value.trim().toLowerCase();
  if (word === "pause" || word === "paused") return "PAUSED";
  if (word === "enable" || word === "enabled") return "ENABLED";
  throw new Error(`A status change takes pause or enable, not "${value}".`);
}

function amount(value: string, kind: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`A ${kind} takes a positive amount in dollars, not "${value}".`);
  return parsed;
}

// One row or refuse. A target that matches nothing is a typo, and a target that
// matches two is a request to change something the caller did not name.
async function exactlyOne(api: AdsClient, query: string, what: string): Promise<Record<string, any>> {
  const rows = await api.gaql(query);
  if (!rows.length) throw new Error(`No ${what} matched. Nothing was changed.`);
  if (rows.length > 1) throw new Error(`${rows.length} ${what}s matched that target; name it more precisely. Nothing was changed.`);
  return rows[0] as Record<string, any>;
}

async function plan(api: AdsClient, params: UpdateParams): Promise<Plan> {
  const target = quoteGaql(params.target);

  if (params.kind === "bid") {
    const row = await exactlyOne(
      api,
      `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.effective_cpc_bid_micros
       FROM keyword_view WHERE ad_group_criterion.keyword.text = ${target}`,
      "keyword",
    );
    const resourceName = String(row.adGroupCriterion.resourceName);
    const bidBefore = moneyOrNull(row.adGroupCriterion.effectiveCpcBidMicros);
    const next = amount(params.value, "bid");
    return {
      service: "adGroupCriteria",
      operations: [{ update: { resourceName, cpcBidMicros: toMicros(next) }, updateMask: "cpc_bid_micros" }],
      before: bidBefore === null ? "not set" : `$${bidBefore.toFixed(2)}`,
      after: `$${next.toFixed(2)}`,
      beforeAmount: bidBefore,
      afterAmount: next,
      pausingLive: false,
      verify: (c) =>
        c
          .gaql(`SELECT ad_group_criterion.effective_cpc_bid_micros FROM keyword_view WHERE ad_group_criterion.resource_name = ${quoteGaql(resourceName)}`)
          .then((rows) => `$${money(rows[0]?.adGroupCriterion?.effectiveCpcBidMicros).toFixed(2)}`),
    };
  }

  if (params.kind === "budget") {
    const row = await exactlyOne(
      api,
      `SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros
       FROM campaign WHERE campaign.name = ${target}`,
      "campaign",
    );
    const resourceName = String(row.campaignBudget.resourceName);
    const budgetBefore = moneyOrNull(row.campaignBudget.amountMicros);
    const next = amount(params.value, "budget");
    return {
      service: "campaignBudgets",
      operations: [{ update: { resourceName, amountMicros: toMicros(next) }, updateMask: "amount_micros" }],
      before: budgetBefore === null ? "not set" : `$${budgetBefore.toFixed(2)}/day`,
      after: `$${next.toFixed(2)}/day`,
      beforeAmount: budgetBefore,
      afterAmount: next,
      pausingLive: false,
      verify: (c) => c.gaql(`SELECT campaign_budget.amount_micros FROM campaign WHERE campaign.name = ${target}`).then((rows) => `$${money(rows[0]?.campaignBudget?.amountMicros).toFixed(2)}/day`),
    };
  }

  if (params.kind === "keywordStatus") {
    const status = statusWord(params.value);
    const row = await exactlyOne(
      api,
      `SELECT ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.keyword.text
       FROM keyword_view WHERE ad_group_criterion.keyword.text = ${target}`,
      "keyword",
    );
    const resourceName = String(row.adGroupCriterion.resourceName);
    const before = String(row.adGroupCriterion.status);
    return {
      service: "adGroupCriteria",
      operations: [{ update: { resourceName, status }, updateMask: "status" }],
      before,
      after: status,
      beforeAmount: 0,
      afterAmount: 0,
      pausingLive: before === "ENABLED" && status === "PAUSED",
      verify: (c) =>
        c
          .gaql(`SELECT ad_group_criterion.status FROM keyword_view WHERE ad_group_criterion.resource_name = ${quoteGaql(resourceName)}`)
          .then((rows) => String(rows[0]?.adGroupCriterion?.status ?? "")),
    };
  }

  if (params.kind === "campaignStatus") {
    const status = statusWord(params.value);
    const row = await exactlyOne(api, `SELECT campaign.resource_name, campaign.name, campaign.status FROM campaign WHERE campaign.name = ${target}`, "campaign");
    const resourceName = String(row.campaign.resourceName);
    const before = String(row.campaign.status);
    return {
      service: "campaigns",
      operations: [{ update: { resourceName, status }, updateMask: "status" }],
      before,
      after: status,
      beforeAmount: 0,
      afterAmount: 0,
      pausingLive: before === "ENABLED" && status === "PAUSED",
      verify: (c) => c.gaql(`SELECT campaign.status FROM campaign WHERE campaign.resource_name = ${quoteGaql(resourceName)}`).then((rows) => String(rows[0]?.campaign?.status ?? "")),
    };
  }

  const status = statusWord(params.value);
  if (!/^\d+$/.test(params.target)) throw new Error(`An ad is named by its numeric id, not "${params.target}".`);
  const row = await exactlyOne(api, `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group.name FROM ad_group_ad WHERE ad_group_ad.ad.id = ${Number(params.target)}`, "ad");
  const resourceName = String(row.adGroupAd.resourceName);
  const before = String(row.adGroupAd.status);
  return {
    service: "adGroupAds",
    operations: [{ update: { resourceName, status }, updateMask: "status" }],
    before,
    after: status,
    beforeAmount: 0,
    afterAmount: 0,
    pausingLive: before === "ENABLED" && status === "PAUSED",
    verify: (c) => c.gaql(`SELECT ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.ad.id = ${Number(params.target)}`).then((rows) => String(rows[0]?.adGroupAd?.status ?? "")),
  };
}

// Reasons in plain words, so a dry run can say why it would refuse instead of
// only that it refused, and the caller confirms something they have read.
function guardReasons(kind: string, before: number | null, after: number, pausingLive: boolean): string[] {
  const reasons: string[] = [];
  if (kind === "bid" || kind === "budget") {
    // An unknown current value must TRIP a guard, never quietly skip one. The
    // old test was `before > 0 && ...`, so a keyword whose bid Google does not
    // return, which is every keyword under an automated bidding strategy, read
    // as zero and the multiple check stopped applying to it entirely.
    if (before === null) {
      reasons.push(
        `the current ${kind} could not be read, so how large a change this is cannot be checked; it may be an automated bidding strategy, where setting a ${kind} changes how the campaign is run`,
      );
    } else if (before > 0 && after > before * MULTIPLE_LIMIT) {
      reasons.push(`${after / before >= 10 ? "over ten" : "more than three"} times the current value, $${before.toFixed(2)} to $${after.toFixed(2)}`);
    }
    if (after > MAX_SINGLE_AMOUNT) reasons.push(`$${after.toFixed(2)} is above the $${MAX_SINGLE_AMOUNT} ceiling for a single ${kind}`);
  }
  // A daily number reads smaller than it is. Saying the month out loud is the
  // whole point: $30 a day against a $100 budget is nine times the budget.
  if (kind === "budget") reasons.push(`a daily budget of $${after.toFixed(2)} is about $${(after * DAYS_PER_MONTH).toFixed(0)} a month`);
  if (pausingLive) reasons.push("this is currently serving, so pausing it stops delivery immediately");
  return reasons;
}

export async function adsUpdate(params: UpdateParams, deps: AdsDeps = {}): Promise<ToolResult> {
  const api = client(deps);
  const change = await plan(api, params);
  const guards = guardReasons(params.kind, change.beforeAmount, change.afterAmount, change.pausingLive);
  const base = {
    kind: params.kind,
    target: params.target,
    before: change.before,
    after: change.after,
    guards,
    customerId: api.customerId,
  };

  if (change.before === change.after) {
    return result(`${params.kind} ${params.target} is already ${change.after}. Nothing to do.`, { ...base, applied: false, noOp: true, readBack: null, matches: null, guards: [] });
  }

  if (params.dryRun) {
    const lines = [
      `Dry run. Nothing was changed.`,
      `${params.kind} ${params.target}: ${change.before} -> ${change.after}`,
      ...guards.map((reason) => `Guard: ${reason}`),
      guards.length ? `This change trips ${guards.length} guard(s). To perform it, call again with dryRun false and confirm true.` : `To perform it, call again with dryRun false.`,
    ];
    return result(lines.join("\n"), { ...base, applied: false, noOp: false, readBack: null, matches: null });
  }

  if (guards.length && !params.confirm) {
    return result(
      [
        `Refused. Nothing was changed.`,
        `${params.kind} ${params.target}: ${change.before} -> ${change.after}`,
        ...guards.map((reason) => `Guard: ${reason}`),
        `Set confirm true to perform it anyway.`,
      ].join("\n"),
      { ...base, applied: false, noOp: false, readBack: null, matches: null },
      true,
    );
  }

  await api.mutate(change.service, change.operations);
  // A 200 says the request was accepted, not that it stored what was meant.
  // Reading the value back is the only evidence that it did.
  const readBack = await change.verify(api);
  const matches = readBack === change.after;
  const lines = [
    `${params.kind} ${params.target}: ${change.before} -> ${change.after}`,
    `Applied. Read back: ${readBack}`,
    matches ? "The stored value matches what was sent." : "The stored value DOES NOT match what was sent. Check the account before relying on this.",
  ];
  return result(lines.join("\n"), { ...base, applied: true, noOp: false, readBack, matches }, !matches);
}

export async function adsNegativesUpdateTool(params: NegativesUpdateParams, deps: AdsDeps = {}): Promise<ToolResult> {
  return adsNegativesUpdate(client(deps), params);
}

export async function adsUpdateBatchTool(params: UpdateBatchParams, deps: AdsDeps = {}): Promise<ToolResult> {
  return adsUpdateBatch(client(deps), params);
}

export async function adsAdCopyTool(params: AdCopyParams, deps: AdsDeps = {}): Promise<ToolResult> {
  return adsAdCopy(client(deps), params);
}

export async function adsAssetsTool(params: AssetsParams, deps: AdsDeps = {}): Promise<ToolResult> {
  return adsAssets(client(deps), params);
}

export async function adsKeywordCreateTool(params: KeywordCreateParams, deps: AdsDeps = {}): Promise<ToolResult> {
  return adsKeywordCreate(client(deps), params);
}
