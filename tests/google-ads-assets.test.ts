import { describe, expect, it, vi } from "vitest";
import { adsAssets } from "../src/google-ads-assets.js";
import { adsAssetsInput, adsAssetsOutput } from "../src/schemas.js";
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

// Routes by the FROM clause, the way the three levels are three separate reads.
function route(byResource: Record<string, unknown[]>) {
  return (query: string): unknown[] => {
    for (const [resource, rows] of Object.entries(byResource)) {
      if (query.includes(`FROM ${resource}`)) return rows;
    }
    return [];
  };
}

const parse = (params: Record<string, unknown> = {}) => adsAssetsInput.parse(params);

describe("adsAssets", () => {
  it("says what a promotion actually offers, not only that one is attached", async () => {
    const { api } = fakeApi(
      route({
        campaign_asset: [
          {
            campaign: { name: "search-brand" },
            campaignAsset: { fieldType: "PROMOTION", status: "ENABLED" },
            asset: {
              id: "1",
              type: "PROMOTION",
              finalUrls: ["https://example.com/pricing"],
              promotionAsset: {
                promotionTarget: "Pro plan",
                discountModifier: "UP_TO",
                percentOff: "200000",
                promotionCode: "LAUNCH20",
                occasion: "NEW_YEARS",
                startDate: "2026-01-01",
                endDate: "2026-01-31",
              },
            },
          },
        ],
      }),
    );
    const result = await adsAssets(api, parse());
    const content = result.structuredContent as { assets: Array<{ summary: string; level: string }> };
    // 200000 is 20%, because Google states the percentage in millionths where
    // 1,000,000 is 100%. Printed raw it reads as nothing anyone recognises.
    expect(content.assets[0]?.summary).toBe("up to 20% off on Pro plan with code LAUNCH20 (NEW_YEARS), 2026-01-01 to 2026-01-31 -> https://example.com/pricing");
    expect(content.assets[0]?.level).toBe("campaign");
    expect(() => adsAssetsOutput.parse(content)).not.toThrow();
  });

  it("renders a money discount and an orders-over trigger", async () => {
    const { api } = fakeApi(
      route({
        campaign_asset: [
          {
            campaign: { name: "c" },
            campaignAsset: { fieldType: "PROMOTION", status: "ENABLED" },
            asset: {
              id: "1",
              type: "PROMOTION",
              promotionAsset: { promotionTarget: "Backup Pro", moneyAmountOff: { amountMicros: "15000000", currencyCode: "USD" }, ordersOverAmount: { amountMicros: "50000000", currencyCode: "USD" } },
            },
          },
        ],
      }),
    );
    const result = await adsAssets(api, parse());
    expect((result.structuredContent as { assets: Array<{ summary: string }> }).assets[0]?.summary).toBe("15.00 USD off on Backup Pro on orders over 50.00 USD");
  });

  it("lists account-level assets even when one campaign is named, and says why", async () => {
    const { api, queries } = fakeApi(
      route({
        customer_asset: [{ customerAsset: { fieldType: "CALLOUT", status: "ENABLED" }, asset: { id: "9", type: "CALLOUT", calloutAsset: { calloutText: "Free 30-day trial" } } }],
        campaign_asset: [],
      }),
    );
    const result = await adsAssets(api, parse({ campaign: "search-brand" }));
    const content = result.structuredContent as { assets: Array<{ level: string; attachedTo: string }> };
    expect(content.assets).toHaveLength(1);
    expect(content.assets[0]?.level).toBe("account");
    expect(content.assets[0]?.attachedTo).toBe("the whole account");
    // The campaign filter must not be applied to the account-level query: those
    // assets are not scoped to a campaign, and dropping them would hide the ones
    // most likely to be serving beside an ad that looks bare.
    const accountQuery = queries.find((query) => query.includes("FROM customer_asset")) ?? "";
    expect(accountQuery).not.toContain("campaign.name =");
    expect(queries.find((query) => query.includes("FROM campaign_asset"))).toContain("campaign.name = 'search-brand'");
    expect(result.content[0]?.text).toContain("An account-level asset applies to every campaign");
  });

  it("records a level it could not read instead of reporting nothing attached", async () => {
    const { api } = fakeApi((query: string) => {
      if (query.includes("FROM campaign_asset")) throw new Error("Google Ads returned HTTP 400 for googleAds:searchStream: Unrecognized field.");
      if (query.includes("FROM customer_asset")) return [{ customerAsset: { fieldType: "SITELINK", status: "ENABLED" }, asset: { id: "3", type: "SITELINK", sitelinkAsset: { linkText: "Pricing" } } }];
      return [];
    });
    const result = await adsAssets(api, parse());
    const content = result.structuredContent as { assets: unknown[]; levelErrors: Array<{ level: string; error: string }> };
    // The other two levels still come back. An empty list that quietly meant
    // "the query broke" would read as "nothing attached", which is the wrong
    // answer to the only question this tool gets asked.
    expect(content.assets).toHaveLength(1);
    expect(content.levelErrors[0]?.level).toBe("campaign");
    expect(content.levelErrors[0]?.error).toContain("Unrecognized field");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Could not read campaign assets");
  });

  it("counts by type so an absent type is visible as absent", async () => {
    const { api } = fakeApi(
      route({
        customer_asset: [
          { customerAsset: { fieldType: "SITELINK", status: "ENABLED" }, asset: { id: "1", type: "SITELINK", sitelinkAsset: { linkText: "Pricing", description1: "Plans", description2: "From $9" } } },
          { customerAsset: { fieldType: "SITELINK", status: "ENABLED" }, asset: { id: "2", type: "SITELINK", sitelinkAsset: { linkText: "Docs" } } },
        ],
      }),
    );
    const result = await adsAssets(api, parse());
    const content = result.structuredContent as { byType: Record<string, number>; assets: Array<{ summary: string }> };
    expect(content.byType).toEqual({ SITELINK: 2 });
    expect(content.assets[0]?.summary).toBe('"Pricing": Plans / From $9');
  });

  it("renders a price asset's offerings", async () => {
    const { api } = fakeApi(
      route({
        campaign_asset: [
          {
            campaign: { name: "c" },
            campaignAsset: { fieldType: "PRICE", status: "ENABLED" },
            asset: {
              id: "1",
              type: "PRICE",
              priceAsset: {
                type: "SERVICES",
                priceQualifier: "FROM",
                priceOfferings: [
                  { header: "Starter", price: { amountMicros: "9000000", currencyCode: "USD" }, unit: "PER_MONTH" },
                  { header: "Pro", price: { amountMicros: "29000000", currencyCode: "USD" }, unit: "PER_MONTH" },
                ],
              },
            },
          },
        ],
      }),
    );
    const result = await adsAssets(api, parse());
    expect((result.structuredContent as { assets: Array<{ summary: string }> }).assets[0]?.summary).toBe("SERVICES (from): Starter 9.00 USD per month; Pro 29.00 USD per month");
  });

  it("names a type it has no shaped reading for instead of inventing a summary", async () => {
    const { api } = fakeApi(route({ customer_asset: [{ customerAsset: { fieldType: "LEAD_FORM", status: "ENABLED" }, asset: { id: "7", type: "LEAD_FORM", name: "Contact us" } }] }));
    const result = await adsAssets(api, parse());
    expect((result.structuredContent as { assets: Array<{ summary: string }> }).assets[0]?.summary).toBe("LEAD_FORM Contact us, not read in detail by this tool");
  });

  it("excludes removed links by default and filters by type when asked", async () => {
    const { api, queries } = fakeApi(() => []);
    await adsAssets(api, parse({ type: "SITELINK" }));
    expect(queries[0]).toContain("customer_asset.status != 'REMOVED'");
    expect(queries[0]).toContain("asset.type = 'SITELINK'");

    const all = fakeApi(() => []);
    await adsAssets(all.api, parse({ includeRemoved: true }));
    expect(all.queries[0]).not.toContain("!= 'REMOVED'");
  });

  it("says an account with nothing attached is showing the ad text alone", async () => {
    const { api } = fakeApi(() => []);
    const result = await adsAssets(api, parse());
    expect(result.content[0]?.text).toContain("showing the ad text alone");
    expect(result.isError).toBeUndefined();
  });
});
