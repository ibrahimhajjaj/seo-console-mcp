import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { adsUpdateBatchInput } from "./schemas.js";
import { quoteGaql, money, toMicros, type AdsClient } from "./google-ads.js";

type Params = z.output<typeof adsUpdateBatchInput>;

const MAX_SINGLE_AMOUNT = 25;
const MULTIPLE_LIMIT = 3;
const DAYS_PER_MONTH = 30.4;
// A batch can be reasonable item by item and large in total. This is the number
// that catches five sensible raises adding up to one that is not.
const MAX_BATCH_INCREASE = 50;

interface Resolved {
  target: string;
  resourceName: string;
  before: number;
  after: number;
}

function itemGuards(kind: string, before: number, after: number): string[] {
  const guards: string[] = [];
  if (before > 0 && after > before * MULTIPLE_LIMIT) {
    guards.push(`${after / before >= 10 ? "over ten" : "more than three"} times the current value, $${before.toFixed(2)} to $${after.toFixed(2)}`);
  }
  if (after > MAX_SINGLE_AMOUNT) guards.push(`$${after.toFixed(2)} is above the $${MAX_SINGLE_AMOUNT} ceiling for a single ${kind}`);
  return guards;
}

// Everything resolves before anything is written. If entry four is ambiguous,
// entries one to three must not already be live: a half-applied batch leaves the
// account in a state nobody chose and no single row anywhere says so.
async function resolveAll(api: AdsClient, params: Params): Promise<Resolved[]> {
  const named = new Set<string>();
  const byResource = new Map<string, string>();
  const resolved: Resolved[] = [];

  for (const change of params.changes) {
    const key = change.target.trim().toLowerCase();
    if (named.has(key)) {
      throw new Error(`"${change.target}" is listed twice in this batch. Nothing was changed; name each target once, with the value you want it to end at.`);
    }
    named.add(key);

    const target = quoteGaql(change.target);
    const what = params.kind === "bid" ? "keyword" : "campaign";
    const rows =
      params.kind === "bid"
        ? await api.gaql(
            `SELECT ad_group_criterion.resource_name, ad_group_criterion.effective_cpc_bid_micros
             FROM keyword_view WHERE ad_group_criterion.keyword.text = ${target}`,
          )
        : await api.gaql(`SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.name = ${target}`);

    if (!rows.length) throw new Error(`No ${what} matched "${change.target}". Every entry must match exactly one; nothing in this batch was changed.`);
    if (rows.length > 1) {
      throw new Error(`${rows.length} ${what}s matched "${change.target}"; name it more precisely. Every entry must match exactly one; nothing in this batch was changed.`);
    }

    const row = rows[0] as Record<string, any>;
    const block = params.kind === "bid" ? row.adGroupCriterion : row.campaignBudget;
    const resourceName = String(block?.resourceName ?? "");
    if (!resourceName) throw new Error(`Google Ads returned no resource name for "${change.target}". Nothing in this batch was changed.`);

    // Two campaigns can share one budget, so two differently named entries can
    // land on the same thing. Left alone that double-counts the total and sends
    // two operations for one resource, with the last value silently winning.
    const other = byResource.get(resourceName);
    if (other !== undefined) {
      throw new Error(
        `"${change.target}" and "${other}" are the same ${params.kind === "bid" ? "keyword" : "budget"} in this account, so one entry would overwrite the other. Nothing in this batch was changed.`,
      );
    }
    byResource.set(resourceName, change.target);

    resolved.push({
      target: change.target,
      resourceName,
      before: money(params.kind === "bid" ? block.effectiveCpcBidMicros : block.amountMicros),
      after: change.value,
    });
  }
  return resolved;
}

async function readBack(api: AdsClient, params: Params, entry: Resolved): Promise<number | null> {
  const rows =
    params.kind === "bid"
      ? await api.gaql(`SELECT ad_group_criterion.effective_cpc_bid_micros FROM keyword_view WHERE ad_group_criterion.resource_name = ${quoteGaql(entry.resourceName)}`)
      : await api.gaql(`SELECT campaign_budget.amount_micros FROM campaign WHERE campaign.name = ${quoteGaql(entry.target)}`);
  const row = rows[0] as Record<string, any> | undefined;
  const micros = params.kind === "bid" ? row?.adGroupCriterion?.effectiveCpcBidMicros : row?.campaignBudget?.amountMicros;
  // Absent is not zero. A row that came back empty says the value is unknown,
  // and reporting it as $0.00 would be a number nobody can stand behind.
  return micros === undefined || micros === null ? null : money(micros);
}

export async function adsUpdateBatch(api: AdsClient, params: Params): Promise<ToolResult> {
  const resolved = await resolveAll(api, params);
  const changing = resolved.filter((entry) => entry.before !== entry.after);

  const entries = resolved.map((entry) => ({
    target: entry.target,
    before: entry.before,
    after: entry.after,
    guards: entry.before === entry.after ? [] : itemGuards(params.kind, entry.before, entry.after),
    applied: false,
    readBack: null as number | null,
    matches: null as boolean | null,
  }));

  const notes = [
    "Every entry was resolved before anything was written, so an entry that cannot be matched stops the whole batch instead of leaving the earlier ones already live.",
    "The total is guarded as well as each entry. Five separately reasonable raises are one large spend change, and making them one at a time is how that goes unnoticed.",
  ];

  const totalBefore = changing.reduce((sum, entry) => sum + entry.before, 0);
  const totalAfter = changing.reduce((sum, entry) => sum + entry.after, 0);
  const base = { kind: params.kind, customerId: api.customerId, totalBefore, totalAfter, notes };

  if (!changing.length) {
    return {
      content: [
        { type: "text", text: ["Nothing to do: every entry is already at the value asked for.", ...entries.map((entry) => `- ${entry.target}: already $${entry.after.toFixed(2)}`)].join("\n") },
      ],
      structuredContent: { ...base, entries, totalGuards: [], applied: false },
    };
  }

  const totalGuards: string[] = [];
  // A daily number reads smaller than it is, and a column of daily numbers reads
  // smaller still. Saying the month out loud is the whole point.
  if (params.kind === "budget") {
    totalGuards.push(
      `these daily budgets come to $${totalAfter.toFixed(2)} a day, about $${(totalAfter * DAYS_PER_MONTH).toFixed(0)} a month, up from about $${(totalBefore * DAYS_PER_MONTH).toFixed(0)} a month`,
    );
  }
  const increase = totalAfter - totalBefore;
  if (increase > MAX_BATCH_INCREASE) {
    totalGuards.push(`the batch raises the total by $${increase.toFixed(2)}, above the $${MAX_BATCH_INCREASE} ceiling for one batch`);
  }
  if (changing.length > 1 && totalBefore > 0 && totalAfter > totalBefore * MULTIPLE_LIMIT) {
    totalGuards.push(`the batch total is more than three times what it is now, $${totalBefore.toFixed(2)} to $${totalAfter.toFixed(2)}`);
  }
  const anyGuard = totalGuards.length > 0 || entries.some((entry) => entry.guards.length > 0);

  const lines = [
    `${params.kind} batch: ${changing.length} change(s)${changing.length === entries.length ? "" : `, ${entries.length - changing.length} already at the value asked for`}`,
    ...entries.map((entry) =>
      entry.before === entry.after
        ? `- ${entry.target}: already $${entry.after.toFixed(2)}, nothing to do`
        : `- ${entry.target}: $${entry.before.toFixed(2)} -> $${entry.after.toFixed(2)}${entry.guards.length ? ` (${entry.guards.join("; ")})` : ""}`,
    ),
    `Total of the entries being changed: $${totalBefore.toFixed(2)} -> $${totalAfter.toFixed(2)}`,
    ...totalGuards.map((guard) => `Guard: ${guard}`),
  ];

  if (params.dryRun) {
    return {
      content: [
        {
          type: "text",
          text: [
            "Dry run. Nothing was changed.",
            ...lines,
            anyGuard
              ? `This batch trips ${totalGuards.length + entries.reduce((count, entry) => count + entry.guards.length, 0)} guard(s). To perform it, call again with dryRun false and confirm true.`
              : "To perform it, call again with dryRun false.",
            ...notes,
          ].join("\n"),
        },
      ],
      structuredContent: { ...base, entries, totalGuards, applied: false },
    };
  }

  if (anyGuard && !params.confirm) {
    return {
      content: [{ type: "text", text: ["Refused. Nothing was changed.", ...lines, "Set confirm true to perform the whole batch anyway.", ...notes].join("\n") }],
      structuredContent: { ...base, entries, totalGuards, applied: false },
      isError: true,
    };
  }

  const service = params.kind === "bid" ? "adGroupCriteria" : "campaignBudgets";
  await api.mutate(
    service,
    changing.map((entry) =>
      params.kind === "bid"
        ? { update: { resourceName: entry.resourceName, cpcBidMicros: toMicros(entry.after) }, updateMask: "cpc_bid_micros" }
        : { update: { resourceName: entry.resourceName, amountMicros: toMicros(entry.after) }, updateMask: "amount_micros" },
    ),
  );

  // Read every one of them back. One accepted request is one acceptance, not N
  // stored values, and a batch is exactly where a partial landing hides.
  for (const entry of changing) {
    const reported = entries.find((candidate) => candidate.target === entry.target);
    if (!reported) continue;
    reported.applied = true;
    reported.readBack = await readBack(api, params, entry);
    reported.matches = reported.readBack !== null && reported.readBack === entry.after;
  }

  const missed = entries.filter((entry) => entry.matches === false);
  return {
    content: [
      {
        type: "text",
        text: [
          ...lines,
          `Applied. ${changing.length - missed.length} of ${changing.length} read back as the value sent.`,
          ...missed.map((entry) => `- ${entry.target}: sent $${entry.after.toFixed(2)}, the account reads ${entry.readBack === null ? "nothing" : `$${entry.readBack.toFixed(2)}`}`),
          ...(missed.length ? ["These DID NOT store what was sent. Check the account before relying on this."] : []),
          ...notes,
        ].join("\n"),
      },
    ],
    structuredContent: { ...base, entries, totalGuards, applied: true },
    ...(missed.length ? { isError: true } : {}),
  };
}
