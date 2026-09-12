import { describe, expect, it, vi } from "vitest";
import { adsAdCopy } from "../src/google-ads-copy.js";
import { adsAdCopyInput, adsAdCopyOutput } from "../src/schemas.js";
import type { AdsClient } from "../src/google-ads.js";

function fakeApi(handler: (query: string) => unknown[]): { api: AdsClient; queries: string[] } {
  const queries: string[] = [];
  const api: AdsClient = {
    customerId: "1234567890",
    gaql: async (query: string) => {
      queries.push(query);
      return handler(query) as Array<Record<string, unknown>>;
    },
    mutate: vi.fn() as unknown as AdsClient["mutate"],
  };
  return { api, queries };
}

function rsa(options: {
  id: string;
  adGroup?: string;
  headlines: Array<{ text: string; pinnedField?: string; performanceLabel?: string }>;
  descriptions?: Array<{ text: string; pinnedField?: string }>;
  approval?: string;
  topics?: Array<{ topic: string; type: string }>;
}) {
  return {
    campaign: { name: "search-brand" },
    adGroup: { name: options.adGroup ?? "brand-exact" },
    adGroupAd: {
      status: "ENABLED",
      adStrength: "POOR",
      policySummary: { approvalStatus: options.approval ?? "APPROVED", policyTopicEntries: options.topics ?? [] },
      ad: {
        id: options.id,
        type: "RESPONSIVE_SEARCH_AD",
        finalUrls: ["https://example.com/"],
        responsiveSearchAd: { headlines: options.headlines, descriptions: options.descriptions ?? [{ text: "One description" }], path1: "backup", path2: "plugin" },
      },
    },
  };
}

const parse = (params: Record<string, unknown> = {}) => adsAdCopyInput.parse(params);

describe("adsAdCopy", () => {
  it("returns the headline and description text, which is what no other read gives", async () => {
    const { api } = fakeApi(() => [rsa({ id: "111", headlines: [{ text: "WordPress Backup Plugin" }, { text: "Restore In One Click" }] })]);
    const result = await adsAdCopy(api, parse());
    const content = result.structuredContent as { ads: Array<{ headlines: Array<{ text: string }>; descriptions: Array<{ text: string }>; paths: string[] }> };
    expect(content.ads[0]?.headlines.map((asset) => asset.text)).toEqual(["WordPress Backup Plugin", "Restore In One Click"]);
    expect(content.ads[0]?.descriptions.map((asset) => asset.text)).toEqual(["One description"]);
    expect(content.ads[0]?.paths).toEqual(["backup", "plugin"]);
    expect(result.content[0]?.text).toContain("H: WordPress Backup Plugin");
    expect(() => adsAdCopyOutput.parse(content)).not.toThrow();
  });

  it("reports pinning, which is a common reason strength reads lower than the copy deserves", async () => {
    const { api } = fakeApi(() => [
      rsa({
        id: "111",
        headlines: [
          { text: "Pinned First", pinnedField: "HEADLINE_1" },
          { text: "Free Floating", pinnedField: "UNSPECIFIED" },
        ],
      }),
    ]);
    const result = await adsAdCopy(api, parse());
    const content = result.structuredContent as { ads: Array<{ headlines: Array<{ pinned: string | null }>; observations: string[] }> };
    // UNSPECIFIED is Google writing "unset", not a position, and carrying it
    // through would read as a real pin.
    expect(content.ads[0]?.headlines.map((asset) => asset.pinned)).toEqual(["HEADLINE_1", null]);
    expect(content.ads[0]?.observations.join(" ")).toContain("1 headline(s) and 0 description(s) are pinned");
    expect(result.content[0]?.text).toContain("[pinned HEADLINE_1]");
  });

  it("names the policy topic rather than only the approval status word", async () => {
    const { api } = fakeApi(() => [rsa({ id: "111", headlines: [{ text: "Best Backup Ever" }], approval: "APPROVED_LIMITED", topics: [{ topic: "TRADEMARKS_IN_AD_TEXT", type: "LIMITED" }] })]);
    const result = await adsAdCopy(api, parse());
    const content = result.structuredContent as { ads: Array<{ policyTopics: Array<{ topic: string; type: string }> }> };
    expect(content.ads[0]?.policyTopics).toEqual([{ topic: "TRADEMARKS_IN_AD_TEXT", type: "LIMITED" }]);
    expect(result.content[0]?.text).toContain("Policy: TRADEMARKS_IN_AD_TEXT (LIMITED)");
  });

  it("counts the copy against what Google wants, so Poor becomes something to act on", async () => {
    const { api } = fakeApi(() => [rsa({ id: "111", headlines: [{ text: "Only One" }] })]);
    const result = await adsAdCopy(api, parse());
    const content = result.structuredContent as { ads: Array<{ observations: string[] }> };
    expect(content.ads[0]?.observations[0]).toBe("1 of 15 headlines, 1 of 4 descriptions.");
  });

  it("flags a headline repeated inside one ad", async () => {
    const { api } = fakeApi(() => [rsa({ id: "111", headlines: [{ text: "Backup Plugin" }, { text: "backup plugin" }] })]);
    const result = await adsAdCopy(api, parse());
    const content = result.structuredContent as { ads: Array<{ observations: string[] }> };
    expect(content.ads[0]?.observations.join(" ")).toContain('Repeated inside this ad: "backup plugin"');
  });

  it("finds headline text shared across two ads, which no per-ad view shows", async () => {
    const { api } = fakeApi(() => [
      rsa({ id: "111", headlines: [{ text: "Shared Headline" }, { text: "Unique To One" }] }),
      rsa({ id: "222", adGroup: "generic", headlines: [{ text: "Shared Headline" }, { text: "Unique To Two" }] }),
    ]);
    const result = await adsAdCopy(api, parse());
    const content = result.structuredContent as { duplicateHeadlines: Array<{ text: string; ads: string[]; adGroups: string[] }> };
    expect(content.duplicateHeadlines).toHaveLength(1);
    expect(content.duplicateHeadlines[0]?.text).toBe("Shared Headline");
    expect(content.duplicateHeadlines[0]?.ads).toEqual(["111", "222"]);
    expect(content.duplicateHeadlines[0]?.adGroups).toEqual(["brand-exact", "generic"]);
    expect(result.content[0]?.text).toContain('"Shared Headline" in 2 ads');
  });

  it("says a non-responsive ad has no copy in these fields rather than reporting it as empty", async () => {
    const { api } = fakeApi(() => [{ campaign: { name: "c" }, adGroup: { name: "g" }, adGroupAd: { status: "ENABLED", ad: { id: "999", type: "EXPANDED_TEXT_AD" } } }]);
    const result = await adsAdCopy(api, parse());
    const content = result.structuredContent as { ads: Array<{ type: string; observations: string[] }> };
    expect(content.ads[0]?.type).toBe("EXPANDED_TEXT_AD");
    expect(content.ads[0]?.observations[0]).toContain("its text is not in the responsive search ad fields");
  });

  it("excludes removed ads by default and filters by ad group and id when asked", async () => {
    const { api, queries } = fakeApi(() => []);
    await adsAdCopy(api, parse());
    expect(queries[0]).toContain("ad_group_ad.status != 'REMOVED'");

    const filtered = fakeApi(() => []);
    await adsAdCopy(filtered.api, parse({ adGroup: "brand-exact", adId: "111", includeRemoved: true }));
    expect(filtered.queries[0]).toContain("ad_group.name = 'brand-exact'");
    expect(filtered.queries[0]).toContain("ad_group_ad.ad.id = 111");
    expect(filtered.queries[0]).not.toContain("!= 'REMOVED'");
  });

  it("escapes an ad group name carrying an apostrophe instead of matching the wrong thing", async () => {
    const { api, queries } = fakeApi(() => []);
    await adsAdCopy(api, parse({ adGroup: "ibrahim's group" }));
    expect(queries[0]).toContain("ad_group.name = 'ibrahim\\'s group'");
  });

  it("says why an empty result can be empty", async () => {
    const { api } = fakeApi(() => []);
    const result = await adsAdCopy(api, parse());
    expect(result.content[0]?.text).toContain("an ad group whose ads were all replaced reads as empty here");
  });
});
