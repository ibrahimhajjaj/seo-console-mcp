import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { adsUpdateBatchInput } from "./schemas.js";
import { quoteGaql, money, moneyOrNull, toMicros, type AdsClient } from "./google-ads.js";

type Params = z.output<typeof adsUpdateBatchInput>;

// Per entry these stay flat however big the batch is, because the per-entry
// question is whether that one entry is a typo, and a typo does not become more
// acceptable in a longer list.
const MAX_SINGLE_AMOUNT = 25;
const MULTIPLE_LIMIT = 3;
const DAYS_PER_MONTH = 30.4;

// The batch ceiling grows with the batch, because a guard that trips on every
// realistic batch is not a guard, it is a checkbox: once confirm is routine it
// gets passed unread, and the day it fires for a real reason nobody notices. It
// grows slowly, though. Twenty entries is not twenty times the risk of one, it
// is one decision taken once.
const BATCH_BASE = 25;
const BATCH_PER_ENTRY = 5;
const batchCeiling = (count: number): number => BATCH_BASE + BATCH_PER_ENTRY * count;

// A typo hides inside an acceptable total, which is the whole way a batch
// differs from the same writes sent one at a time. Nineteen entries moving a few
// cents and one moving $40 can sit under every ceiling and still be the mistake.
const OUTLIER_MULTIPLE = 4;
const OUTLIER_FLOOR = 1;

interface Resolved {
  target: string;
  resourceName: string;
  before: number | null;
  after: number;
}

interface Entry {
  target: string;
  before: number | null;
  after: number;
  guards: string[];
  applied: boolean;
  readBack: number | null;
  matches: boolean | null;
}

function itemGuards(kind: string, before: number | null, after: number): string[] {
  const guards: string[] = [];
  // Unknown must trip rather than skip. Reading it as zero made the multiple
  // check stop applying to exactly the entries nobody can sanity-check by eye.
  if (before === null) {
    guards.push(`the current ${kind} could not be read, so how large a change this is cannot be checked`);
  } else if (before > 0 && after > before * MULTIPLE_LIMIT) {
    guards.push(`${after / before >= 10 ? "over ten" : "more than three"} times the current value, $${before.toFixed(2)} to $${after.toFixed(2)}`);
  }
  if (after > MAX_SINGLE_AMOUNT) guards.push(`$${after.toFixed(2)} is above the $${MAX_SINGLE_AMOUNT} ceiling for a single ${kind}`);
  return guards;
}

// Named rather than only counted: "one entry is out of line with the rest" is
// useless unless it says which one.
function outliers(changing: Resolved[]): Map<string, string> {
  const flagged = new Map<string, string>();
  // Under three entries there is no "rest of the batch" to be out of line with,
  // and both entries are already in front of the reader.
  if (changing.length < 3) return flagged;
  // An entry whose current value is unknown has no move to compare.
  const moves = changing
    .filter((entry) => entry.before !== null)
    .map((entry) => Math.abs(entry.after - (entry.before as number)))
    .sort((first, second) => first - second);
  const middle = moves.length / 2;
  if (!moves.length) return flagged;
  const median = moves.length % 2 === 1 ? (moves[Math.floor(middle)] as number) : ((moves[middle - 1] as number) + (moves[middle] as number)) / 2;
  if (!moves.length || median <= 0) return flagged;
  for (const entry of changing) {
    if (entry.before === null) continue;
    const move = Math.abs(entry.after - entry.before);
    if (move >= OUTLIER_FLOOR && move > median * OUTLIER_MULTIPLE) {
      flagged.set(entry.target, `this moves $${move.toFixed(2)} while the middle of the batch moves $${median.toFixed(2)}, so it is out of line with the other ${changing.length - 1} entries`);
    }
  }
  return flagged;
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
      before: moneyOrNull(params.kind === "bid" ? block.effectiveCpcBidMicros : block.amountMicros),
      after: change.value,
    });
  }
  return resolved;
}

async function readCurrent(api: AdsClient, params: Params, entry: Resolved): Promise<number | null> {
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
  const flagged = outliers(changing);

  const entries: Entry[] = resolved.map((entry) => ({
    target: entry.target,
    before: entry.before,
    after: entry.after,
    guards: entry.before === entry.after ? [] : [...itemGuards(params.kind, entry.before, entry.after), ...(flagged.has(entry.target) ? [flagged.get(entry.target) as string] : [])],
    applied: false,
    readBack: null,
    matches: null,
  }));

  const notes = [
    "Every entry was resolved before anything was written, so an entry that cannot be matched stops the whole batch instead of leaving the earlier ones already live.",
    "The total is guarded as well as each entry. Five separately reasonable raises are one large spend change, and making them one at a time is how that goes unnoticed.",
    "An entry far out of line with the rest is named even when the total is within every ceiling, because that is where a typo hides in a batch.",
  ];

  // A total built by treating unknowns as zero is not a total. It understates
  // what the account holds now and overstates the increase, so it is reported
  // as unknown and the size checks that depend on it are replaced by a guard.
  const unknownBefore = changing.filter((entry) => entry.before === null);
  const totalBefore = unknownBefore.length ? null : changing.reduce((sum, entry) => sum + (entry.before as number), 0);
  const totalAfter = changing.reduce((sum, entry) => sum + entry.after, 0);

  // Always said out loud, tripped or not. A daily number reads smaller than it
  // is and a column of daily numbers reads smaller still, and the sentence is
  // the thing that actually gets read: the guard is only what stops someone when
  // it does not.
  const from = totalBefore === null ? `an unknown total, because ${unknownBefore.length} of these have no current ${params.kind} to read` : null;
  const totalSummary =
    params.kind === "budget"
      ? `These daily budgets come to $${totalAfter.toFixed(2)} a day, about $${(totalAfter * DAYS_PER_MONTH).toFixed(0)} a month, up from ${from ?? `$${(totalBefore as number).toFixed(2)} a day, about $${((totalBefore as number) * DAYS_PER_MONTH).toFixed(0)} a month`}.`
      : `These bids come to $${totalAfter.toFixed(2)} per click across ${changing.length} keyword(s), up from ${from ?? `$${(totalBefore as number).toFixed(2)}`}. What that costs depends on clicks, which no setting here fixes.`;

  const base = { kind: params.kind, customerId: api.customerId, totalBefore, totalAfter, totalSummary, notes };

  if (!changing.length) {
    return {
      content: [
        { type: "text", text: ["Nothing to do: every entry is already at the value asked for.", ...entries.map((entry) => `- ${entry.target}: already $${entry.after.toFixed(2)}`)].join("\n") },
      ],
      structuredContent: { ...base, totalSummary: "Nothing is being changed, so there is no total to report.", entries, totalGuards: [], applied: false },
    };
  }

  const totalGuards: string[] = [];
  const ceiling = batchCeiling(changing.length);
  if (totalBefore === null) {
    // The size checks are arithmetic on the current total, and there is no
    // current total. Saying so is the guard; inventing a zero would pass.
    totalGuards.push(
      `${unknownBefore.length} of these ${changing.length} entries have no current ${params.kind} to read (${unknownBefore.map((entry) => entry.target).join(", ")}), so the size of this batch cannot be checked against what the account holds now`,
    );
  } else {
    const increase = totalAfter - totalBefore;
    if (increase > ceiling) {
      totalGuards.push(`the batch raises the total by $${increase.toFixed(2)}, above the $${ceiling.toFixed(2)} ceiling for a batch of ${changing.length}`);
    }
    if (changing.length > 1 && totalBefore > 0 && totalAfter > totalBefore * MULTIPLE_LIMIT) {
      totalGuards.push(`the batch total is more than three times what it is now, $${totalBefore.toFixed(2)} to $${totalAfter.toFixed(2)}`);
    }
  }
  const guardCount = totalGuards.length + entries.reduce((count, entry) => count + entry.guards.length, 0);

  const lines = [
    `${params.kind} batch: ${changing.length} change(s)${changing.length === entries.length ? "" : `, ${entries.length - changing.length} already at the value asked for`}`,
    ...entries.map((entry) =>
      entry.before === entry.after
        ? `- ${entry.target}: already $${entry.after.toFixed(2)}, nothing to do`
        : `- ${entry.target}: ${entry.before === null ? "not set" : `$${entry.before.toFixed(2)}`} -> $${entry.after.toFixed(2)}${entry.guards.length ? ` (${entry.guards.join("; ")})` : ""}`,
    ),
    `Total of the entries being changed: ${totalBefore === null ? "unknown" : `$${totalBefore.toFixed(2)}`} -> $${totalAfter.toFixed(2)}`,
    totalSummary,
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
            guardCount
              ? `This batch trips ${guardCount} guard(s). To perform it, call again with dryRun false and confirm true.`
              : "Nothing tripped a guard. To perform it, call again with dryRun false.",
            ...notes,
          ].join("\n"),
        },
      ],
      structuredContent: { ...base, entries, totalGuards, applied: false },
    };
  }

  if (guardCount && !params.confirm) {
    return {
      content: [{ type: "text", text: ["Refused. Nothing was changed.", ...lines, "Set confirm true to perform the whole batch anyway.", ...notes].join("\n") }],
      structuredContent: { ...base, entries, totalGuards, applied: false },
      isError: true,
    };
  }

  const service = params.kind === "bid" ? "adGroupCriteria" : "campaignBudgets";
  try {
    await api.mutate(
      service,
      changing.map((entry) =>
        params.kind === "bid"
          ? { update: { resourceName: entry.resourceName, cpcBidMicros: toMicros(entry.after) }, updateMask: "cpc_bid_micros" }
          : { update: { resourceName: entry.resourceName, amountMicros: toMicros(entry.after) }, updateMask: "amount_micros" },
      ),
    );
  } catch (error) {
    // The request does not ask for partial failure, so Google either takes the
    // whole batch or none of it. Saying which one happened is the difference
    // between a reader checking the account and a reader guessing about it.
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} This batch was sent as one request without partial failure, so none of the ${changing.length} entries should have been written. Read the account back before sending it again.`,
    );
  }

  // Read every one of them back. One accepted request is one acceptance, not N
  // stored values, and a batch is exactly where a partial landing hides.
  for (const entry of changing) {
    const reported = entries.find((candidate) => candidate.target === entry.target);
    if (!reported) continue;
    reported.applied = true;
    try {
      reported.readBack = await readCurrent(api, params, entry);
    } catch {
      // A read that fails is not a write that failed, and losing the rest of the
      // report over it would hide the entries that did land.
      reported.readBack = null;
    }
    reported.matches = reported.readBack !== null && reported.readBack === entry.after;
  }

  const stored = entries.filter((entry) => entry.matches === true);
  const missed = entries.filter((entry) => entry.matches === false);
  const applied = [
    // The failures first and by name, because on a partial landing the question
    // is never "how many" but "which ones, and what does the account hold now".
    `Applied. ${stored.length} of ${changing.length} stored what was sent.`,
    ...(missed.length
      ? [
          `These DID NOT store what was sent. Check the account before relying on them:`,
          ...missed.map(
            (entry) => `- ${entry.target}: sent $${entry.after.toFixed(2)}, ${entry.readBack === null ? "and the value could not be read back" : `the account reads $${entry.readBack.toFixed(2)}`}`,
          ),
        ]
      : []),
    ...(stored.length ? ["Live now, confirmed by reading the account back:", ...stored.map((entry) => `- ${entry.target}: $${(entry.readBack as number).toFixed(2)}`)] : []),
  ];

  return {
    content: [{ type: "text", text: [...lines, ...applied, ...notes].join("\n") }],
    structuredContent: { ...base, entries, totalGuards, applied: true },
    ...(missed.length ? { isError: true } : {}),
  };
}
