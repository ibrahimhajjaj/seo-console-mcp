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
      appStoreDiscoveryInput.parse({ appId: "1", locales: ["en-GB", "ar-SA"], include: ["searchKeywords"], includeRows: true }),
      { fetchImpl, credentials: credentials() },
    );

    const keywords = (result.structuredContent as any).resources.searchKeywords;
    expect(keywords.count).toBe(2);
    expect(keywords.rows.map((row: any) => row.locale)).toEqual(["en-GB", "ar-SA"]);
  });

  it("reads the locales concurrently rather than one round trip at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const locale = decodeURIComponent(String(input).match(/locale%5D=([^&]+)/)?.[1] ?? "");
      return new Response(JSON.stringify({ data: [{ type: "appKeywords", id: `kw-${locale}` }] }), { status: 200 });
    });

    const result = await appStoreDiscovery(
      appStoreDiscoveryInput.parse({ appId: "1", locales: ["en-US", "en-GB", "ar-SA"], include: ["searchKeywords"], includeRows: true }),
      { fetchImpl, credentials: credentials() },
    );

    expect(maxInFlight).toBeGreaterThan(1);
    // Overlapping calls must not reorder the answer: rows still follow the
    // requested locales, not whichever response landed first.
    const rows = (result.structuredContent as any).resources.searchKeywords.rows;
    expect(rows.map((row: any) => row.locale)).toEqual(["en-US", "en-GB", "ar-SA"]);
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

  it("keeps the count but withholds the rows unless they were asked for", async () => {
    const fetchImpl = router(() => ({ status: 200, body: { data: [{ type: "appKeywords", id: "kw" }] } }));

    const result = await appStoreDiscovery(
      appStoreDiscoveryInput.parse({ appId: "1", include: ["appTags"] }),
      { fetchImpl, credentials: credentials() },
    );
    const content = result.structuredContent as any;

    expect(content.resources.appTags).toMatchObject({ available: true, count: 1 });
    expect(content.resources.appTags.rows).toEqual([]);
    expect(content.notes.join(" ")).toMatch(/pass includeRows to see them/);
  });

  it("returns the rows and drops the note when includeRows is set", async () => {
    const fetchImpl = router(() => ({ status: 200, body: { data: [{ type: "appKeywords", id: "kw" }] } }));

    const result = await appStoreDiscovery(
      appStoreDiscoveryInput.parse({ appId: "1", include: ["appTags"], includeRows: true }),
      { fetchImpl, credentials: credentials() },
    );
    const content = result.structuredContent as any;

    expect(content.resources.appTags.rows).toHaveLength(1);
    expect(content.notes.join(" ")).not.toMatch(/pass includeRows to see them/);
  });

  it("requires an appId or a bundleId", async () => {
    await expect(appStoreDiscovery(appStoreDiscoveryInput.parse({}), { fetchImpl: router(() => ({ status: 200, body: { data: [] } })), credentials: credentials() }))
      .rejects.toThrow(/appId or bundleId/);
  });
});
