import { describe, expect, it, vi } from "vitest";
import { adsUpdateBatch } from "../src/google-ads-batch.js";
import { adsUpdateBatchInput, adsUpdateBatchOutput } from "../src/schemas.js";
import type { AdsClient } from "../src/google-ads.js";

function fakeApi(handler: (query: string) => unknown[], mutate = vi.fn(async () => ({}))): { api: AdsClient; mutate: typeof mutate } {
  const api: AdsClient = {
    customerId: "1234567890",
    gaql: async (query: string) => handler(query) as Array<Record<string, unknown>>,
    mutate: mutate as unknown as AdsClient["mutate"],
  };
  return { api, mutate };
}

const keyword = (text: string, resource: string, bid: number) => ({
  text,
  row: { adGroupCriterion: { resourceName: resource, effectiveCpcBidMicros: String(bid * 1e6) } },
});

// A keyword lookup answers by the quoted text in the query, so a batch can be
// routed the same way the live API would route it: one row each, by name.
function keywordRoute(rows: Array<ReturnType<typeof keyword>>, stored: Map<string, number> = new Map()) {
  return (query: string): unknown[] => {
    if (query.includes("ad_group_criterion.resource_name =")) {
      const resource = /resource_name = '([^']+)'/.exec(query)?.[1] ?? "";
      const value = stored.get(resource);
      return value === undefined ? [] : [{ adGroupCriterion: { effectiveCpcBidMicros: String(value * 1e6) } }];
    }
    const text = /keyword\.text = '([^']+)'/.exec(query)?.[1] ?? "";
    return rows.filter((entry) => entry.text === text).map((entry) => entry.row);
  };
}

const parse = (params: Record<string, unknown>) => adsUpdateBatchInput.parse(params);

describe("adsUpdateBatch", () => {
  it("resolves every entry before writing anything, so one bad entry changes nothing", async () => {
    const { api, mutate } = fakeApi(keywordRoute([keyword("one", "customers/1/adGroupCriteria/1~1", 1), keyword("two", "customers/1/adGroupCriteria/1~2", 1)]));
    await expect(
      adsUpdateBatch(
        api,
        parse({
          kind: "bid",
          changes: [
            { target: "one", value: 2 },
            { target: "two", value: 2 },
            { target: "missing", value: 2 },
          ],
          dryRun: false,
          confirm: true,
        }),
      ),
    ).rejects.toThrow(/No keyword matched "missing"/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refuses when two entries name the same underlying thing", async () => {
    const { api, mutate } = fakeApi(keywordRoute([keyword("one", "customers/1/adGroupCriteria/1~1", 1), keyword("ONE", "customers/1/adGroupCriteria/1~1", 1)]));
    await expect(
      adsUpdateBatch(
        api,
        parse({
          kind: "bid",
          changes: [
            { target: "one", value: 2 },
            { target: "ONE ", value: 3 },
          ],
          dryRun: false,
          confirm: true,
        }),
      ),
    ).rejects.toThrow(/listed twice/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refuses two differently named campaigns that share one budget", async () => {
    // A shared budget is one resource under two names. Left alone the total
    // would count it twice and the second operation would quietly win.
    const { api, mutate } = fakeApi(() => [{ campaignBudget: { resourceName: "customers/1/campaignBudgets/9", amountMicros: "5000000" } }]);
    await expect(
      adsUpdateBatch(
        api,
        parse({
          kind: "budget",
          changes: [
            { target: "brand", value: 6 },
            { target: "generic", value: 7 },
          ],
          dryRun: false,
          confirm: true,
        }),
      ),
    ).rejects.toThrow(/"generic" and "brand" are the same budget/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("guards the sum even when no single entry trips a guard", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => keyword(`k${index}`, `customers/1/adGroupCriteria/1~${index}`, 8));
    const { api, mutate } = fakeApi(keywordRoute(rows));
    const result = await adsUpdateBatch(api, parse({ kind: "bid", changes: rows.map((row) => ({ target: row.text, value: 24 })), dryRun: false }));
    const content = result.structuredContent as { totalGuards: string[]; entries: Array<{ guards: string[] }>; applied: boolean };
    // No entry is more than three times its own value and none is over $25, so
    // every per-item guard is empty; only the total catches this.
    expect(content.entries.every((entry) => entry.guards.length === 0)).toBe(true);
    expect(content.totalGuards.join(" ")).toMatch(/raises the total by \$80\.00, above the \$50\.00 ceiling for a batch of 5/);
    expect(content.applied).toBe(false);
    expect(result.isError).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("names the one entry out of line with the rest even when the total is small", async () => {
    // Nineteen entries moving cents and one moving $40 sits under every ceiling
    // and is still the mistake. The count alone would not say which one.
    const rows = Array.from({ length: 6 }, (_, index) => keyword(`k${index}`, `customers/1/adGroupCriteria/1~${index}`, 5));
    const { api } = fakeApi(keywordRoute(rows));
    const result = await adsUpdateBatch(api, parse({ kind: "bid", changes: rows.map((row, index) => ({ target: row.text, value: index === 4 ? 12 : 5.1 })) }));
    const content = result.structuredContent as { entries: Array<{ target: string; guards: string[] }>; totalGuards: string[] };
    // The batch total rose $7.50, under the $55 ceiling for six entries, and
    // no entry is over $25 or more than three times its own value.
    expect(content.totalGuards).toEqual([]);
    expect(content.entries.filter((entry) => entry.guards.some((guard) => guard.includes("out of line"))).map((entry) => entry.target)).toEqual(["k4"]);
    expect(result.content[0]?.text).toMatch(/k4: \$5\.00 -> \$12\.00 .*out of line with the other 5 entries/);
  });

  it("does not call one of two entries an outlier, since both are already in front of the reader", async () => {
    const rows = [keyword("one", "customers/1/adGroupCriteria/1~1", 5), keyword("two", "customers/1/adGroupCriteria/1~2", 5)];
    const { api } = fakeApi(keywordRoute(rows));
    const result = await adsUpdateBatch(
      api,
      parse({
        kind: "bid",
        changes: [
          { target: "one", value: 5.1 },
          { target: "two", value: 12 },
        ],
      }),
    );
    const content = result.structuredContent as { entries: Array<{ guards: string[] }> };
    expect(content.entries.flatMap((entry) => entry.guards).some((guard) => guard.includes("out of line"))).toBe(false);
  });

  it("lets the batch ceiling grow with the batch, so confirm does not become routine", async () => {
    // The same per-entry move that trips a batch of three passes in a batch of
    // twenty: a guard that fires on every realistic batch gets passed unread.
    const build = (count: number) => Array.from({ length: count }, (_, index) => keyword(`k${index}`, `customers/1/adGroupCriteria/1~${index}`, 1));
    const small = build(3);
    const smallResult = await adsUpdateBatch(fakeApi(keywordRoute(small)).api, parse({ kind: "bid", changes: small.map((row) => ({ target: row.text, value: 15 })) }));
    // 3 entries: $42 increase against a $40 ceiling, so it trips.
    expect((smallResult.structuredContent as { totalGuards: string[] }).totalGuards.join(" ")).toContain("ceiling for a batch of 3");

    const large = build(20);
    const largeResult = await adsUpdateBatch(fakeApi(keywordRoute(large)).api, parse({ kind: "bid", changes: large.map((row) => ({ target: row.text, value: 2 })) }));
    // 20 entries: $20 increase against a $125 ceiling, so it does not.
    expect((largeResult.structuredContent as { totalGuards: string[] }).totalGuards).toEqual([]);
  });

  it("names which entries are live and which are not when only some store", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => keyword(`k${index}`, `customers/1/adGroupCriteria/1~${index}`, 1));
    const stored = new Map([
      ["customers/1/adGroupCriteria/1~0", 2],
      ["customers/1/adGroupCriteria/1~1", 1],
      ["customers/1/adGroupCriteria/1~2", 2],
    ]);
    const { api } = fakeApi(keywordRoute(rows, stored));
    const result = await adsUpdateBatch(api, parse({ kind: "bid", changes: rows.map((row) => ({ target: row.text, value: 2 })), dryRun: false, confirm: true }));
    const text = result.content[0]?.text ?? "";
    // The failures come first and by name. A count alone leaves the reader
    // opening the account to find out which two of three are live.
    expect(text.indexOf("DID NOT store")).toBeLessThan(text.indexOf("Live now"));
    expect(text).toContain("- k1: sent $2.00, the account reads $1.00");
    expect(text).toContain("Live now, confirmed by reading the account back:");
    expect(text).toMatch(/- k0: \$2\.00/);
    expect(text).toMatch(/- k2: \$2\.00/);
  });

  it("says nothing was written when the write itself is refused", async () => {
    const rows = [keyword("one", "customers/1/adGroupCriteria/1~1", 1)];
    const mutate = vi.fn(async () => {
      throw new Error("Google Ads returned HTTP 400 for adGroupCriteria:mutate: too low.");
    });
    const { api } = fakeApi(keywordRoute(rows), mutate);
    await expect(adsUpdateBatch(api, parse({ kind: "bid", changes: [{ target: "one", value: 2 }], dryRun: false, confirm: true }))).rejects.toThrow(/none of the 1 entries should have been written/);
  });

  it("says the monthly figure for a batch of daily budgets", async () => {
    const { api } = fakeApi((query: string) => {
      const name = /campaign\.name = '([^']+)'/.exec(query)?.[1] ?? "";
      return [{ campaignBudget: { resourceName: `customers/1/campaignBudgets/${name}`, amountMicros: "5000000" } }];
    });
    const result = await adsUpdateBatch(
      api,
      parse({
        kind: "budget",
        changes: [
          { target: "brand", value: 6 },
          { target: "generic", value: 7 },
        ],
      }),
    );
    const content = result.structuredContent as { totalGuards: string[]; totalSummary: string };
    // The sentence is always said. It is not a guard: a $2 a day rise that
    // always demanded confirm would teach the reader to pass it unread.
    expect(content.totalGuards).toEqual([]);
    expect(content.totalSummary).toMatch(/\$13\.00 a day, about \$395 a month, up from \$10\.00 a day, about \$304 a month/);
    expect(result.content[0]?.text).toContain("$395 a month");
    expect(result.content[0]?.text).toContain("Nothing tripped a guard.");
    expect(result.content[0]?.text).toContain("Dry run. Nothing was changed.");
  });

  it("writes once, reads every value back, and reports the ones that did not store", async () => {
    const rows = [keyword("one", "customers/1/adGroupCriteria/1~1", 1), keyword("two", "customers/1/adGroupCriteria/1~2", 1)];
    // The second one comes back holding its old value: accepted is not stored.
    const stored = new Map([
      ["customers/1/adGroupCriteria/1~1", 2],
      ["customers/1/adGroupCriteria/1~2", 1],
    ]);
    const { api, mutate } = fakeApi(keywordRoute(rows, stored));
    const result = await adsUpdateBatch(
      api,
      parse({
        kind: "bid",
        changes: [
          { target: "one", value: 2 },
          { target: "two", value: 2 },
        ],
        dryRun: false,
        confirm: true,
      }),
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[1]).toHaveLength(2);
    const content = result.structuredContent as { entries: Array<{ target: string; readBack: number | null; matches: boolean | null }>; applied: boolean };
    expect(content.entries.map((entry) => entry.matches)).toEqual([true, false]);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("the account reads $1.00");
    expect(() => adsUpdateBatchOutput.parse(content)).not.toThrow();
  });

  it("reports an unreadable value as unknown rather than as zero", async () => {
    const { api } = fakeApi(keywordRoute([keyword("one", "customers/1/adGroupCriteria/1~1", 1)], new Map()));
    const result = await adsUpdateBatch(api, parse({ kind: "bid", changes: [{ target: "one", value: 2 }], dryRun: false, confirm: true }));
    const content = result.structuredContent as { entries: Array<{ readBack: number | null }> };
    expect(content.entries[0]?.readBack).toBeNull();
    expect(result.content[0]?.text).toContain("the value could not be read back");
  });

  it("does nothing when every entry already holds the value asked for", async () => {
    const { api, mutate } = fakeApi(keywordRoute([keyword("one", "customers/1/adGroupCriteria/1~1", 2)]));
    const result = await adsUpdateBatch(api, parse({ kind: "bid", changes: [{ target: "one", value: 2 }], dryRun: false, confirm: true }));
    expect(mutate).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("Nothing to do");
    expect((result.structuredContent as { applied: boolean }).applied).toBe(false);
  });

  it("refuses a target that matches more than one row", async () => {
    const { api, mutate } = fakeApi(() => [
      { adGroupCriterion: { resourceName: "a", effectiveCpcBidMicros: "1000000" } },
      { adGroupCriterion: { resourceName: "b", effectiveCpcBidMicros: "1000000" } },
    ]);
    await expect(adsUpdateBatch(api, parse({ kind: "bid", changes: [{ target: "one", value: 2 }], dryRun: false, confirm: true }))).rejects.toThrow(/2 keywords matched/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("holds the changes back to a dry run by default", async () => {
    const { api, mutate } = fakeApi(keywordRoute([keyword("one", "customers/1/adGroupCriteria/1~1", 1)]));
    const result = await adsUpdateBatch(api, parse({ kind: "bid", changes: [{ target: "one", value: 2 }] }));
    expect(mutate).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("To perform it, call again with dryRun false");
  });
});
