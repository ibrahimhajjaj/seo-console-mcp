import { describe, expect, it, vi } from "vitest";
import { wouldBlock, adsNegativesUpdate } from "../src/google-ads-negatives.js";
import { adsNegativesUpdateInput, adsNegativesUpdateOutput } from "../src/schemas.js";
import type { AdsClient } from "../src/google-ads.js";

function fakeApi(handler: (query: string) => unknown[], mutate = vi.fn(async () => ({}))): { api: AdsClient; mutate: typeof mutate } {
  const api: AdsClient = {
    customerId: "1234567890",
    gaql: async (query: string) => handler(query) as Array<Record<string, unknown>>,
    mutate: mutate as unknown as AdsClient["mutate"],
  };
  return { api, mutate };
}

const CAMPAIGN = [{ campaign: { resourceName: "customers/1/campaigns/5", name: "safeguard" } }];

function route(opts: { negatives?: unknown[]; keywords?: unknown[] } = {}) {
  return (query: string): unknown[] => {
    if (query.includes("FROM campaign_criterion")) return opts.negatives ?? [];
    if (query.includes("FROM keyword_view")) return opts.keywords ?? [];
    if (query.includes("FROM campaign ")) return CAMPAIGN;
    return CAMPAIGN;
  };
}

describe("wouldBlock", () => {
  it("treats a broad negative as blocking any keyword carrying all its words", () => {
    // The case that ends a campaign: one common word, added broadly.
    expect(wouldBlock("backup", "BROAD", "wordpress backup")).toBe(true);
    expect(wouldBlock("backup", "BROAD", "backup wordpress site")).toBe(true);
    expect(wouldBlock("backup plugin", "BROAD", "wordpress backup plugin")).toBe(true);
    expect(wouldBlock("migration", "BROAD", "wordpress backup")).toBe(false);
  });

  it("matches a phrase as whole words in order, not as a substring", () => {
    expect(wouldBlock("wordpress backup", "PHRASE", "best wordpress backup plugin")).toBe(true);
    expect(wouldBlock("backup wordpress", "PHRASE", "wordpress backup")).toBe(false);
    // "back" must not read as blocking "backup".
    expect(wouldBlock("back", "PHRASE", "wordpress backup")).toBe(false);
  });

  it("matches exact only on the whole keyword", () => {
    expect(wouldBlock("wordpress backup", "EXACT", "WordPress  Backup")).toBe(true);
    expect(wouldBlock("backup", "EXACT", "wordpress backup")).toBe(false);
  });
});

describe("ads_negatives_update", () => {
  it("refuses a negative that would block the campaign's own live keyword", async () => {
    const { api, mutate } = fakeApi(route({ keywords: [{ adGroupCriterion: { keyword: { text: "wordpress backup" } }, metrics: { impressions: 41 } }] }));

    const result = await adsNegativesUpdate(api, adsNegativesUpdateInput.parse({ action: "add", target: "safeguard", keywords: ["backup"], matchType: "BROAD", dryRun: false }));
    const content = result.structuredContent as { applied: boolean; collisions: Array<{ blocks: string; impressions: number }> };

    expect(result.isError).toBe(true);
    expect(content.applied).toBe(false);
    expect(content.collisions[0]).toMatchObject({ blocks: "wordpress backup", impressions: 41 });
    expect(mutate).not.toHaveBeenCalled();
    expect(() => adsNegativesUpdateOutput.parse(content)).not.toThrow();
  });

  it("states the impressions at risk, because a blocked keyword leaves no other evidence", async () => {
    const { api } = fakeApi(route({ keywords: [{ adGroupCriterion: { keyword: { text: "wordpress backup" } }, metrics: { impressions: 41 } }] }));

    const result = await adsNegativesUpdate(api, adsNegativesUpdateInput.parse({ action: "add", target: "safeguard", keywords: ["backup"], matchType: "BROAD" }));

    expect((result.structuredContent as { guards: string[] }).guards.join(" ")).toMatch(/would block this campaign's own keyword "wordpress backup", which served 41 impressions/);
    expect(result.content[0]?.text).toMatch(/A wrong bid shows up as spend\. A wrong negative shows up as nothing/);
  });

  it("adds cleanly when nothing collides, and reads the terms back", async () => {
    let added = false;
    const api: AdsClient = {
      customerId: "1",
      gaql: async (query: string) => {
        if (query.includes("FROM campaign_criterion")) return added ? [{ campaignCriterion: { keyword: { text: "free" }, criterionId: "9" } }] : [];
        if (query.includes("FROM keyword_view")) return [{ adGroupCriterion: { keyword: { text: "wordpress backup" } }, metrics: { impressions: 41 } }];
        return CAMPAIGN;
      },
      mutate: (async () => {
        added = true;
        return {};
      }) as unknown as AdsClient["mutate"],
    };

    const result = await adsNegativesUpdate(api, adsNegativesUpdateInput.parse({ action: "add", target: "safeguard", keywords: ["free"], matchType: "EXACT", dryRun: false }));
    const content = result.structuredContent as { applied: boolean; changed: string[]; collisions: unknown[] };

    expect(content).toMatchObject({ applied: true, changed: ["free"], collisions: [] });
    expect(result.isError).toBeUndefined();
  });

  it("skips a term already present rather than sending a pointless write", async () => {
    const { api, mutate } = fakeApi(route({ negatives: [{ campaignCriterion: { keyword: { text: "free" }, criterionId: "9" } }] }));

    const result = await adsNegativesUpdate(api, adsNegativesUpdateInput.parse({ action: "add", target: "safeguard", keywords: ["free"], dryRun: false }));
    const content = result.structuredContent as { applied: boolean; skipped: Array<{ reason: string }> };

    expect(content.applied).toBe(false);
    expect(content.skipped[0]?.reason).toMatch(/already a negative here/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not collision-check a removal, which can only let traffic through", async () => {
    const { api } = fakeApi(
      route({
        negatives: [{ campaignCriterion: { keyword: { text: "backup" }, criterionId: "9" } }],
        keywords: [{ adGroupCriterion: { keyword: { text: "wordpress backup" } }, metrics: { impressions: 41 } }],
      }),
    );

    const result = await adsNegativesUpdate(api, adsNegativesUpdateInput.parse({ action: "remove", target: "safeguard", keywords: ["backup"], matchType: "BROAD" }));

    expect((result.structuredContent as { collisions: unknown[] }).collisions).toEqual([]);
  });

  it("refuses a target that does not match exactly one campaign", async () => {
    const { api } = fakeApi(() => []);

    await expect(adsNegativesUpdate(api, adsNegativesUpdateInput.parse({ action: "add", target: "nope", keywords: ["x"] }))).rejects.toThrow(/0 campaigns matched/);
  });
});
