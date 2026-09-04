import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { appStoreReviews } from "../src/app-store-reviews.js";
import { appStoreReviewsInput, appStoreReviewsOutput } from "../src/schemas.js";
import type { AscCredentials } from "../src/app-store-listing.js";

function credentials(): AscCredentials {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { keyId: "ABC123DEFG", issuerId: "issuer", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

function review(id: string, rating: number, extra: Record<string, unknown> = {}) {
  return { type: "customerReviews", id, attributes: { rating, title: "t" + id, body: "b" + id, reviewerNickname: "n", createdDate: "2026-09-01T00:00:00Z", territory: "USA" }, ...extra };
}

function respondingWith(pages: Array<Record<string, unknown>>) {
  let index = 0;
  return vi.fn(async () => new Response(JSON.stringify(pages[Math.min(index++, pages.length - 1)]), { status: 200 }));
}

describe("appStoreReviews", () => {
  it("summarizes fetched reviews without claiming they are the lifetime rating", async () => {
    const fetchImpl = respondingWith([{ data: [review("1", 5), review("2", 3)] }]);

    const result = await appStoreReviews(appStoreReviewsInput.parse({ appId: "123", limit: 10 }), { fetchImpl, credentials: credentials() });
    const content = result.structuredContent as Record<string, any>;

    expect(content.returned).toBe(2);
    expect(content.meanOfFetched).toBe(4);
    expect(content.histogramOfFetched).toEqual({ "1": 0, "2": 0, "3": 1, "4": 0, "5": 1 });
    expect(content.notes.join(" ")).toMatch(/not the app's lifetime rating/);
    expect(() => appStoreReviewsOutput.parse(content)).not.toThrow();
  });

  it("reports zero reviews as zero rather than as a failure", async () => {
    const fetchImpl = respondingWith([{ data: [] }]);

    const result = await appStoreReviews(appStoreReviewsInput.parse({ appId: "123" }), { fetchImpl, credentials: credentials() });
    const content = result.structuredContent as Record<string, any>;

    expect(content.returned).toBe(0);
    expect(content.meanOfFetched).toBeNull();
    expect(result.isError).not.toBe(true);
  });

  it("attaches a developer response and counts the unanswered ones", async () => {
    const fetchImpl = respondingWith([
      {
        data: [review("1", 2, { relationships: { response: { data: { id: "r1" } } } }), review("2", 4)],
        included: [{ type: "customerReviewResponses", id: "r1", attributes: { responseBody: "sorry", lastModifiedDate: "2026-09-02T00:00:00Z" } }],
      },
    ]);

    const result = await appStoreReviews(appStoreReviewsInput.parse({ appId: "123" }), { fetchImpl, credentials: credentials() });
    const content = result.structuredContent as Record<string, any>;

    expect(content.reviews[0].responseBody).toBe("sorry");
    expect(content.reviews[1].responseBody).toBeNull();
    expect(content.withoutResponse).toBe(1);
  });

  it("follows the server's next link and stops at maxPages", async () => {
    const fetchImpl = respondingWith([
      { data: [review("1", 5)], links: { next: "https://api.appstoreconnect.apple.com/v1/apps/123/customerReviews?cursor=2" } },
      { data: [review("2", 5)], links: { next: "https://api.appstoreconnect.apple.com/v1/apps/123/customerReviews?cursor=3" } },
    ]);

    const result = await appStoreReviews(appStoreReviewsInput.parse({ appId: "123", limit: 100, maxPages: 2 }), { fetchImpl, credentials: credentials() });

    expect((result.structuredContent as { pagesRead: number }).pagesRead).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("passes rating and territory filters through", async () => {
    const fetchImpl = respondingWith([{ data: [] }]);

    await appStoreReviews(appStoreReviewsInput.parse({ appId: "123", rating: [1, 2], territory: "USA" }), { fetchImpl, credentials: credentials() });

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("filter%5Brating%5D=1%2C2");
    expect(url).toContain("filter%5Bterritory%5D=USA");
  });

  it("requires an appId or a bundleId", async () => {
    await expect(appStoreReviews(appStoreReviewsInput.parse({}), { fetchImpl: respondingWith([{ data: [] }]), credentials: credentials() })).rejects.toThrow(/appId or bundleId/);
  });
});
