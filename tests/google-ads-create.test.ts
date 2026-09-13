import { describe, expect, it, vi } from "vitest";
import { adsKeywordCreate } from "../src/google-ads-create.js";
import { adsKeywordCreateInput, adsKeywordCreateOutput } from "../src/schemas.js";
import type { AdsClient } from "../src/google-ads.js";

function fakeApi(handler: (query: string) => unknown[], mutate = vi.fn(async () => ({}))): { api: AdsClient; mutate: typeof mutate; queries: string[] } {
  const queries: string[] = [];
  const api: AdsClient = {
    customerId: "1234567890",
    gaql: async (query: string) => {
      queries.push(query);
      return handler(query) as Array<Record<string, unknown>>;
    },
    mutate: mutate as unknown as AdsClient["mutate"],
  };
  return { api, mutate, queries };
}

const AD_GROUP = [{ adGroup: { resourceName: "customers/1/adGroups/7", name: "brand-exact" }, campaign: { name: "search-brand" } }];

// duplicates: rows the duplicate check finds; stored: what reads back after the write.
function route(opts: { duplicates?: unknown[]; stored?: unknown[] } = {}) {
  return (query: string): unknown[] => {
    if (query.includes("FROM ad_group_criterion")) return opts.duplicates ?? [];
    if (query.includes("FROM keyword_view"))
      return opts.stored ?? [{ adGroupCriterion: { keyword: { text: "wordpress backup", matchType: "EXACT" }, status: "ENABLED", effectiveCpcBidMicros: "2000000" } }];
    if (query.includes("FROM ad_group ")) return AD_GROUP;
    return AD_GROUP;
  };
}

const parse = (params: Record<string, unknown>) => adsKeywordCreateInput.parse({ keyword: "wordpress backup", adGroup: "brand-exact", bid: 2, ...params });

describe("adsKeywordCreate", () => {
  it("creates the keyword and reads it back", async () => {
    const { api, mutate } = fakeApi(route());

    const result = await adsKeywordCreate(api, parse({ dryRun: false }));
    const content = result.structuredContent as { applied: boolean; matches: boolean; readBack: { matchType: string; bid: number | null } };

    const operations = mutate.mock.calls[0]?.[1] as Array<{ create: Record<string, any> }>;
    expect(operations[0]?.create).toMatchObject({ adGroup: "customers/1/adGroups/7", status: "ENABLED", cpcBidMicros: "2000000", keyword: { text: "wordpress backup", matchType: "EXACT" } });
    expect(content.applied).toBe(true);
    expect(content.matches).toBe(true);
    expect(content.readBack.matchType).toBe("EXACT");
    expect(() => adsKeywordCreateOutput.parse(content)).not.toThrow();
  });

  it("refuses a keyword that already exists in the target ad group, including a removed one", async () => {
    // A REMOVED criterion still holds the text. Google rejects the duplicate
    // create with an error naming a resource the interface does not show, which
    // is a confusing thing to meet without warning.
    const { api, mutate } = fakeApi(route({ duplicates: [{ adGroup: { name: "brand-exact" }, adGroupCriterion: { status: "REMOVED", keyword: { matchType: "EXACT" } } }] }));

    await expect(adsKeywordCreate(api, parse({ dryRun: false, confirm: true }))).rejects.toThrow(/already exists in ad group "brand-exact" as EXACT with status REMOVED/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("guards rather than refuses a copy in a different ad group, because that can be deliberate", async () => {
    // Refusing would make a legitimate account structure impossible; saying
    // nothing would let two copies compete for one budget silently.
    const { api, mutate } = fakeApi(route({ duplicates: [{ adGroup: { name: "generic" }, adGroupCriterion: { status: "ENABLED", keyword: { matchType: "PHRASE" } } }] }));

    const result = await adsKeywordCreate(api, parse({ dryRun: false }));
    const content = result.structuredContent as { guards: string[]; applied: boolean };

    expect(content.guards.join(" ")).toContain("already exists elsewhere in this account: generic (PHRASE, ENABLED)");
    expect(content.guards.join(" ")).toContain("compete with each other for the same budget");
    expect(content.applied).toBe(false);
    expect(result.isError).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("guards a wider match type, since it buys more than the text written", async () => {
    const { api } = fakeApi(route());

    const broad = await adsKeywordCreate(api, parse({ matchType: "BROAD" }));
    expect((broad.structuredContent as { guards: string[] }).guards.join(" ")).toContain("spends on searches nobody meant to buy");

    const phrase = await adsKeywordCreate(fakeApi(route()).api, parse({ matchType: "PHRASE" }));
    expect((phrase.structuredContent as { guards: string[] }).guards.join(" ")).toContain("buys more than the text written here");

    const exact = await adsKeywordCreate(fakeApi(route()).api, parse({}));
    expect((exact.structuredContent as { guards: string[] }).guards).toEqual([]);
  });

  it("refuses an ad group that matches nothing rather than creating somewhere unintended", async () => {
    const { api, mutate } = fakeApi((query: string) => (query.includes("FROM ad_group ") ? [] : []));

    await expect(adsKeywordCreate(api, parse({ dryRun: false, confirm: true }))).rejects.toThrow(/No ad group named "brand-exact" exists in this account/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("is a dry run by default and says the keyword starts serving immediately", async () => {
    const { api, mutate } = fakeApi(route());

    const result = await adsKeywordCreate(api, parse({}));

    expect(mutate).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("Dry run. Nothing was added.");
    // A create has no previous state to return to, unlike every other write here.
    expect(result.content[0]?.text).toContain("there is no previous state to return to");
  });

  it("reports a keyword it cannot read back as unverified rather than as created", async () => {
    const { api } = fakeApi(route({ stored: [] }));

    const result = await adsKeywordCreate(api, parse({ dryRun: false }));
    const content = result.structuredContent as { readBack: unknown; matches: boolean };

    expect(content.readBack).toBeNull();
    expect(content.matches).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("could not be read back");
  });

  it("guards a bid above the single-bid ceiling", async () => {
    const { api } = fakeApi(route());
    const result = await adsKeywordCreate(api, parse({ bid: 40 }));
    expect((result.structuredContent as { guards: string[] }).guards.join(" ")).toContain("above the $25 ceiling");
  });
});
