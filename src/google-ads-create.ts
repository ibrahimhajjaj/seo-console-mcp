import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { adsKeywordCreateInput } from "./schemas.js";
import { quoteGaql, moneyOrNull, toMicros, type AdsClient } from "./google-ads.js";

type Params = z.output<typeof adsKeywordCreateInput>;

const MAX_SINGLE_AMOUNT = 25;

interface Existing {
  adGroup: string;
  status: string;
  matchType: string;
}

// Creating is not modifying, and the difference is the guard. Every other write
// here reads a current value, compares it to the one asked for, and refuses when
// they already match. A create has no current value: there is nothing to compare
// and nothing to refuse against, so the comparison has to be replaced rather
// than skipped. What replaces it is a duplicate check, because the failure a
// create makes is a second copy of a keyword quietly competing with the first
// for the same budget.
async function findExisting(api: AdsClient, keyword: string): Promise<Existing[]> {
  // ad_group_criterion rather than keyword_view, because a REMOVED criterion
  // still holds the text and still blocks a create. Google answers the duplicate
  // with an error naming a resource that cannot be seen in the interface, which
  // is a confusing thing to meet if you have not met it before.
  const rows = await api.gaql(
    `SELECT ad_group.name, ad_group_criterion.status, ad_group_criterion.keyword.match_type
     FROM ad_group_criterion
     WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = false
       AND ad_group_criterion.keyword.text = ${quoteGaql(keyword)}`,
  );
  return rows.map((row) => ({
    adGroup: String(row.adGroup?.name ?? ""),
    status: String(row.adGroupCriterion?.status ?? ""),
    matchType: String(row.adGroupCriterion?.keyword?.matchType ?? ""),
  }));
}

export async function adsKeywordCreate(api: AdsClient, params: Params): Promise<ToolResult> {
  const existing = await findExisting(api, params.keyword);
  const here = existing.filter((row) => row.adGroup.trim().toLowerCase() === params.adGroup.trim().toLowerCase());
  if (here.length) {
    const row = here[0] as Existing;
    throw new Error(
      `"${params.keyword}" already exists in ad group "${row.adGroup}" as ${row.matchType} with status ${row.status}. Nothing was added. Google refuses a second copy of the same text in one ad group, and a REMOVED one still holds the text; change the existing one with ads_update instead.`,
    );
  }

  const rows = await api.gaql(`SELECT ad_group.resource_name, ad_group.name, campaign.name FROM ad_group WHERE ad_group.name = ${quoteGaql(params.adGroup)}`);
  if (!rows.length)
    throw new Error(`No ad group named "${params.adGroup}" exists in this account, so nothing was added. This is not the same as the ad group being empty; check the name against ads_keywords.`);
  if (rows.length > 1) throw new Error(`${rows.length} ad groups matched "${params.adGroup}"; name it more precisely. Nothing was added.`);
  const target = rows[0] as Record<string, any>;
  const adGroupResource = String(target.adGroup?.resourceName ?? "");
  const campaign = String(target.campaign?.name ?? "");

  const guards: string[] = [];
  // There is no before-value, so the "more than three times the current amount"
  // check has nothing to work from. Passing zero in its place is what turned
  // that guard off elsewhere in this package; saying so is the honest version.
  if (params.bid > MAX_SINGLE_AMOUNT) guards.push(`$${params.bid.toFixed(2)} is above the $${MAX_SINGLE_AMOUNT} ceiling for a single bid`);
  if (params.matchType === "BROAD") {
    guards.push("BROAD matches any query Google considers related, including ones that share no words with this keyword, so it is the match type that spends on searches nobody meant to buy");
  } else if (params.matchType === "PHRASE") {
    guards.push("PHRASE matches any query containing this as a phrase, so it buys more than the text written here");
  }
  if (existing.length) {
    guards.push(
      `"${params.keyword}" already exists elsewhere in this account: ${existing.map((row) => `${row.adGroup} (${row.matchType}, ${row.status})`).join(", ")}. Two copies of one keyword compete with each other for the same budget unless that is deliberate`,
    );
  }

  const notes = [
    "A create has no current value to compare against, so it is guarded by a duplicate check rather than by a before-and-after. A second copy of a keyword competes with the first for the same budget, and nothing in the interface says so.",
    "The duplicate check covers removed keywords too. A removed criterion still holds the text, and Google refuses the create with an error naming a resource that cannot be seen in the interface.",
    "This keyword starts serving as soon as it is created. Unlike a bid change, there is no previous state to return to; undoing it means pausing or removing what was made.",
  ];

  const summary = [`Add "${params.keyword}" as ${params.matchType} to ad group "${params.adGroup}" (campaign ${campaign}) at $${params.bid.toFixed(2)}`, ...guards.map((guard) => `Guard: ${guard}`)];
  const base = { keyword: params.keyword, adGroup: params.adGroup, campaign, matchType: params.matchType, bid: params.bid, guards, customerId: api.customerId, notes };

  if (params.dryRun) {
    return {
      content: [
        {
          type: "text",
          text: [
            "Dry run. Nothing was added.",
            ...summary,
            guards.length ? `This trips ${guards.length} guard(s). To perform it, call again with dryRun false and confirm true.` : "To perform it, call again with dryRun false.",
            ...notes,
          ].join("\n"),
        },
      ],
      structuredContent: { ...base, applied: false, readBack: null, matches: null },
    };
  }
  if (guards.length && !params.confirm) {
    return {
      content: [{ type: "text", text: ["Refused. Nothing was added.", ...summary, "Set confirm true to add it anyway.", ...notes].join("\n") }],
      structuredContent: { ...base, applied: false, readBack: null, matches: null },
      isError: true,
    };
  }

  await api.mutate("adGroupCriteria", [
    {
      create: {
        adGroup: adGroupResource,
        status: "ENABLED",
        cpcBidMicros: toMicros(params.bid),
        keyword: { text: params.keyword, matchType: params.matchType },
      },
    },
  ]);

  // A 200 on a create says the request was accepted, not that the keyword is
  // there with the match type, status and bid that were sent.
  const back = await findExistingRow(api, params);
  const matches = back !== null && back.matchType === params.matchType && back.status === "ENABLED";

  return {
    content: [
      {
        type: "text",
        text: [
          ...summary,
          back === null
            ? "Applied, but the keyword could not be read back. Check the account before relying on this."
            : `Applied. Read back: ${back.text} ${back.matchType} ${back.status} at ${back.bid === null ? "no bid reported" : `$${back.bid.toFixed(2)}`}`,
          matches ? "The stored keyword matches what was sent." : "The stored keyword DOES NOT match what was sent. Check the account before relying on this.",
          ...notes,
        ].join("\n"),
      },
    ],
    structuredContent: { ...base, applied: true, readBack: back, matches },
    ...(matches ? {} : { isError: true }),
  };
}

async function findExistingRow(api: AdsClient, params: Params): Promise<{ text: string; matchType: string; status: string; bid: number | null } | null> {
  const rows = await api.gaql(
    `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
            ad_group_criterion.status, ad_group_criterion.effective_cpc_bid_micros
     FROM keyword_view WHERE ad_group_criterion.keyword.text = ${quoteGaql(params.keyword)}
       AND ad_group.name = ${quoteGaql(params.adGroup)}`,
  );
  const row = rows[0] as Record<string, any> | undefined;
  if (!row?.adGroupCriterion) return null;
  return {
    text: String(row.adGroupCriterion.keyword?.text ?? ""),
    matchType: String(row.adGroupCriterion.keyword?.matchType ?? ""),
    status: String(row.adGroupCriterion.status ?? ""),
    bid: moneyOrNull(row.adGroupCriterion.effectiveCpcBidMicros),
  };
}
