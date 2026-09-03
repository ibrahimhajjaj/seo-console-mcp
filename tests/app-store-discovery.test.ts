import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { appStoreDiscovery } from "../src/app-store-discovery.js";
import { appStoreDiscoveryInput, appStoreDiscoveryOutput } from "../src/schemas.js";
import type { AscCredentials } from "../src/app-store-listing.js";

function credentials(): AscCredentials {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { keyId: "K", issuerId: "I", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

function router(handler: (url: string) => { status: number; body: unknown }) {
  return vi.fn(async (input: string | URL | Request) => {
    const { status, body } = handler(String(input));
    return new Response(JSON.stringify(body), { status });
  });
}

describe("appStoreDiscovery", () => {
  it("sends each resource its own required filters", async () => {
    const seen: string[] = [];
    const fetchImpl = router((url) => {
      seen.push(url);
      return { status: 200, body: { data: [{ type: "appKeywords", id: "shared list" }] } };
    });

    await appStoreDiscovery(appStoreDiscoveryInput.parse({ appId: "1", locales: ["en-US"] }), { fetchImpl, credentials: credentials() });

    const keywords = seen.find((url) => url.includes("/searchKeywords")) ?? "";
    // Both filters are required; omitting either returns 400, which would read
    // as "unavailable" when it is really a malformed request.
    expect(keywords).toContain("filter%5Bplatform%5D=IOS");
    expect(keywords).toContain("filter%5Blocale%5D=en-US");
    // A to-one relationship rejects limit outright.
    expect(seen.find((url) => url.includes("appAvailabilityV2"))).not.toContain("limit=");
  });

  it("reads keywords once per locale and tags each row", async () => {
    const fetchImpl = router((url) => {
      if (!url.includes("/searchKeywords")) return { status: 200, body: { data: [] } };
      const locale = decodeURIComponent(url.match(/locale%5D=([^&]+)/)?.[1] ?? "");
      return { status: 200, body: { data: [{ type: "appKeywords", id: `kw-${locale}` }] } };
    });

    const result = await appStoreDiscovery(
      appStoreDiscoveryInput.parse({ appId: "1", locales: ["en-GB", "ar-SA"], include: ["searchKeywords"] }),
      { fetchImpl, credentials: credentials() },
    );

    const keywords = (result.structuredContent as any).resources.searchKeywords;
    expect(keywords.count).toBe(2);
    expect(keywords.rows.map((row: any) => row.locale)).toEqual(["en-GB", "ar-SA"]);
  });

  it("separates a resource it cannot read from one that is genuinely empty", async () => {
    const fetchImpl = router((url) => url.includes("appEvents")
      ? { status: 403, body: { errors: [{ detail: "forbidden" }] } }
      : { status: 200, body: { data: [] } });

    const result = await appStoreDiscovery(
      appStoreDiscoveryInput.parse({ appId: "1", include: ["appEvents", "appTags"] }),
      { fetchImpl, credentials: credentials() },
    );
    const resources = (result.structuredContent as any).resources;

    expect(resources.appTags).toMatchObject({ available: true, count: 0 });
    expect(resources.appEvents).toMatchObject({ available: false, count: null });
    expect((result.structuredContent as any).notes.join(" ")).toMatch(/unknown rather than empty/);
    expect(() => appStoreDiscoveryOutput.parse(result.structuredContent)).not.toThrow();
  });

  it("requires an appId or a bundleId", async () => {
    await expect(appStoreDiscovery(appStoreDiscoveryInput.parse({}), { fetchImpl: router(() => ({ status: 200, body: { data: [] } })), credentials: credentials() }))
      .rejects.toThrow(/appId or bundleId/);
  });
});
