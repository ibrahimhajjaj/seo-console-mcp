import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { adsNegativesUpdateInput } from "./schemas.js";
import { quoteGaql, type AdsClient } from "./google-ads.js";

type Params = z.output<typeof adsNegativesUpdateInput>;

export interface NegativeCollision {
  negative: string;
  blocks: string;
  impressions: number;
}

const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");
const tokens = (text: string): string[] => normalize(text).split(" ").filter(Boolean);

// Whether a negative would stop a keyword serving. This mirrors Google's own
// matching closely enough to catch the case that matters, but Google is the
// authority: it is deliberately generous, because a false warning costs a
// sentence and a missed one costs the campaign.
export function wouldBlock(negative: string, matchType: string, keyword: string): boolean {
  const negativeText = normalize(negative);
  const keywordText = normalize(keyword);
  if (!negativeText || !keywordText) return false;
  if (matchType === "EXACT") return negativeText === keywordText;
  if (matchType === "PHRASE") {
    // Contiguous run of words, not a bare substring: "back" must not read as
    // blocking "backup" when the phrase is a word.
    const keywordTokens = tokens(keywordText);
    const negativeTokens = tokens(negativeText);
    return keywordTokens.some((_, index) => negativeTokens.every((token, offset) => keywordTokens[index + offset] === token));
  }
  // BROAD blocks any query carrying all of its words in any order, which is why
  // a single common word added broadly can end a campaign's traffic.
  const keywordTokens = new Set(tokens(keywordText));
  return tokens(negativeText).every((token) => keywordTokens.has(token));
}

interface ResolvedTarget {
  resourceName: string;
  name: string;
  campaignName: string;
}

async function resolveTarget(api: AdsClient, params: Params): Promise<ResolvedTarget> {
  const target = quoteGaql(params.target);
  if (params.level === "campaign") {
    const rows = await api.gaql(`SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.name = ${target}`);
    if (rows.length !== 1) throw new Error(`${rows.length} campaigns matched "${params.target}". Exactly one is required; nothing was changed.`);
    return { resourceName: String(rows[0]?.campaign?.resourceName), name: String(rows[0]?.campaign?.name), campaignName: String(rows[0]?.campaign?.name) };
  }
  const rows = await api.gaql(`SELECT ad_group.resource_name, ad_group.name, campaign.name FROM ad_group WHERE ad_group.name = ${target}`);
  if (rows.length !== 1) throw new Error(`${rows.length} ad groups matched "${params.target}". Exactly one is required; nothing was changed.`);
  return { resourceName: String(rows[0]?.adGroup?.resourceName), name: String(rows[0]?.adGroup?.name), campaignName: String(rows[0]?.campaign?.name ?? "") };
}

async function existingNegatives(api: AdsClient, target: ResolvedTarget, level: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const rows =
    level === "campaign"
      ? await api.gaql(
          `SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
           FROM campaign_criterion WHERE campaign_criterion.negative = true AND campaign_criterion.type = 'KEYWORD'
             AND campaign.resource_name = ${quoteGaql(target.resourceName)}`,
        )
      : await api.gaql(
          `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
           FROM ad_group_criterion WHERE ad_group_criterion.negative = true AND ad_group_criterion.type = 'KEYWORD'
             AND ad_group.resource_name = ${quoteGaql(target.resourceName)}`,
        );
  for (const row of rows) {
    const block = row.campaignCriterion ?? row.adGroupCriterion;
    const text = normalize(String(block?.keyword?.text ?? ""));
    if (text) found.set(text, String(block?.criterionId ?? ""));
  }
  return found;
}

// The campaign's own live keywords, with the traffic each one carries, so a
// collision can be reported with the cost of getting it wrong attached.
async function liveKeywords(api: AdsClient, campaignName: string): Promise<Array<{ text: string; impressions: number }>> {
  const rows = await api.gaql(
    `SELECT ad_group_criterion.keyword.text, metrics.impressions
     FROM keyword_view WHERE campaign.name = ${quoteGaql(campaignName)}
       AND ad_group_criterion.status != 'REMOVED'`,
  );
  const byText = new Map<string, number>();
  for (const row of rows) {
    const text = String(row.adGroupCriterion?.keyword?.text ?? "");
    if (!text) continue;
    byText.set(text, (byText.get(text) ?? 0) + Number(row.metrics?.impressions ?? 0));
  }
  return [...byText].map(([text, impressions]) => ({ text, impressions }));
}

export async function adsNegativesUpdate(api: AdsClient, params: Params): Promise<ToolResult> {
  const target = await resolveTarget(api, params);
  const existing = await existingNegatives(api, target, params.level);

  const skipped: Array<{ keyword: string; reason: string }> = [];
  const actionable: string[] = [];
  for (const keyword of params.keywords) {
    const key = normalize(keyword);
    const present = existing.has(key);
    if (params.action === "add" && present) skipped.push({ keyword, reason: "already a negative here" });
    else if (params.action === "remove" && !present) skipped.push({ keyword, reason: "not a negative here, so there is nothing to remove" });
    else actionable.push(keyword);
  }

  // Only adding can block traffic. Removing a negative can only let traffic
  // through, which is visible as spend rather than as silence.
  const collisions: NegativeCollision[] = [];
  if (params.action === "add" && actionable.length) {
    const keywords = await liveKeywords(api, target.campaignName);
    for (const negative of actionable) {
      for (const keyword of keywords) {
        if (wouldBlock(negative, params.matchType, keyword.text)) {
          collisions.push({ negative, blocks: keyword.text, impressions: keyword.impressions });
        }
      }
    }
  }

  const guards = collisions.map(
    (collision) =>
      `"${collision.negative}" as a ${params.matchType} negative would block this campaign's own keyword "${collision.blocks}", which served ${collision.impressions} impressions in the window checked`,
  );
  const notes = [
    // The asymmetry that justifies the whole guard.
    "A wrong bid shows up as spend. A wrong negative shows up as nothing: the traffic stops arriving, the term leaves the search terms report, and no row anywhere says why.",
    "Collision checking mirrors Google's matching closely but Google is the authority, and it is deliberately generous: a false warning costs a sentence, a missed one costs the campaign.",
  ];

  const base = {
    action: params.action,
    level: params.level,
    target: target.name,
    matchType: params.matchType,
    requested: params.keywords,
    skipped,
    collisions,
    guards,
    notes,
  };

  if (!actionable.length) {
    return {
      content: [{ type: "text", text: `Nothing to do: every term asked for is already in the state requested.\n${skipped.map((entry) => `- ${entry.keyword}: ${entry.reason}`).join("\n")}` }],
      structuredContent: { ...base, applied: false, changed: [] },
    };
  }

  const summary = [
    `${params.action === "add" ? "Add" : "Remove"} ${actionable.length} negative(s) at ${params.level} "${target.name}" as ${params.matchType}`,
    ...actionable.map((keyword) => `- ${keyword}`),
    ...skipped.map((entry) => `- ${entry.keyword}: skipped, ${entry.reason}`),
    ...guards.map((guard) => `Guard: ${guard}`),
  ];

  if (params.dryRun) {
    return {
      content: [
        {
          type: "text",
          text: [
            "Dry run. Nothing was changed.",
            ...summary,
            guards.length ? "To perform it, call again with dryRun false and confirm true." : "To perform it, call again with dryRun false.",
            ...notes,
          ].join("\n"),
        },
      ],
      structuredContent: { ...base, applied: false, changed: [] },
    };
  }

  if (guards.length && !params.confirm) {
    return {
      content: [{ type: "text", text: ["Refused. Nothing was changed.", ...summary, "Set confirm true to add these anyway.", ...notes].join("\n") }],
      structuredContent: { ...base, applied: false, changed: [] },
      isError: true,
    };
  }

  // Everything resolved before anything is written, so an ambiguous entry
  // cannot leave the earlier ones already live.
  const service = params.level === "campaign" ? "campaignCriteria" : "adGroupCriteria";
  const owner = params.level === "campaign" ? "campaign" : "adGroup";
  const operations = actionable.map((keyword) =>
    params.action === "add"
      ? { create: { [owner]: target.resourceName, negative: true, keyword: { text: keyword, matchType: params.matchType } } }
      : { remove: `${target.resourceName.replace(/\/(campaigns|adGroups)\//, params.level === "campaign" ? "/campaignCriteria/" : "/adGroupCriteria/")}~${existing.get(normalize(keyword))}` },
  );
  await api.mutate(service, operations);

  const after = await existingNegatives(api, target, params.level);
  const landed = actionable.filter((keyword) => (params.action === "add" ? after.has(normalize(keyword)) : !after.has(normalize(keyword))));
  const missed = actionable.filter((keyword) => !landed.includes(keyword));

  return {
    content: [
      {
        type: "text",
        text: [
          ...summary,
          `Applied. Read back: ${landed.length} of ${actionable.length} are now in the state asked for.`,
          ...(missed.length ? [`These did NOT land and the account does not match what was sent: ${missed.join(", ")}`] : []),
          ...notes,
        ].join("\n"),
      },
    ],
    structuredContent: { ...base, applied: true, changed: landed },
    ...(missed.length ? { isError: true } : {}),
  };
}
