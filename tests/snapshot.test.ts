import { describe, expect, it, vi } from "vitest";
import { snapshot } from "../src/snapshot.js";
import { snapshotInput, snapshotOutput } from "../src/schemas.js";
import type { ToolContext } from "../src/registry.js";
import type { GoogleClients, ToolResult } from "../src/google-tools.js";

const NOW = new Date("2026-09-03T11:30:45Z");
const SNAPSHOT_DIR = "/snapshots";

const ctx: ToolContext = {
  getClients: () => { throw new Error("no clients in test"); },
  getAuthenticatedClients: () => { throw new Error("no clients in test"); },
};

function params(overrides: Record<string, unknown> = {}) {
  return snapshotInput.parse(overrides);
}

function readers(overrides: Record<string, unknown> = {}) {
  return {
    now: NOW,
    // The snapshot directory is pinned and every filesystem call is injected, so
    // a test run never reaches a real path.
    env: { SEO_MCP_SNAPSHOT_DIR: SNAPSHOT_DIR },
    fileExists: () => false,
    makeDir: () => {},
    readProperty: vi.fn(async (siteUrl: string) => ({
      siteUrl,
      totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 5, daysWithData: 28, firstIncompleteDate: null },
      topQueries: { rows: [], truncated: false },
      topPages: { rows: [], truncated: false },
    })),
    readApp: vi.fn(async (app: string) => ({ app, versionString: "1.4.0", localeCount: 7, hasEditableRecord: false, ratings: [] })),
    readPackage: vi.fn(async (packageName: string) => ({ package: packageName, activeDeviceInstalls: 12, lastDatePresent: "2026-08-23" })),
    readSlug: vi.fn(async (slug: string) => ({ slug, activeInstalls: 100, downloaded: 500, rating: 90, numRatings: 3 })),
    ...overrides,
  };
}

describe("snapshot", () => {
  it("captures every surface into one timestamped document", async () => {
    const deps = readers();

    const result = await snapshot(ctx, params({
      properties: ["https://example.com/"],
      apps: ["1234567890"],
      packages: ["app.example"],
      slugs: ["akismet"],
    }), deps);

    const document = result.structuredContent as Record<string, any>;
    expect(document.takenAt).toBe("2026-09-03T11:30Z");
    expect(document.window).toEqual({ startDate: "2026-08-07", endDate: "2026-09-03" });
    expect(document.properties).toHaveLength(1);
    expect(document.apps).toHaveLength(1);
    expect(document.packages).toHaveLength(1);
    expect(document.slugs).toHaveLength(1);
    expect(document.surfacesWithErrors).toEqual([]);
    expect(() => snapshotOutput.parse(document)).not.toThrow();
  });

  it("records a failed surface in place instead of dropping it", async () => {
    const deps = readers({
      readPackage: vi.fn(async () => { throw new Error("bucket unreachable"); }),
    });

    const result = await snapshot(ctx, params({
      properties: ["https://example.com/"],
      packages: ["app.example"],
    }), deps);

    const document = result.structuredContent as Record<string, any>;
    // The surface is present with an error, never silently absent: a missing
    // surface would read later as a drop to zero.
    expect(document.packages).toHaveLength(1);
    expect(document.packages[0]).toMatchObject({ package: "app.example", error: "bucket unreachable" });
    expect(document.packages[0].activeDeviceInstalls).toBeUndefined();
    expect(document.surfacesWithErrors).toEqual(["package:app.example"]);
    expect(document.properties[0].totals.clicks).toBe(10);
    expect(result.content[0]?.text).toContain("missing, not zero");
  });

  it("keeps going when one surface hangs", async () => {
    const deps = readers({
      readApp: vi.fn(() => new Promise(() => {})),
      surfaceTimeoutMs: 20,
    });

    const result = await snapshot(ctx, params({ apps: ["1234567890"], slugs: ["akismet"] }), deps);

    const document = result.structuredContent as Record<string, any>;
    expect(document.surfacesWithErrors).toEqual(["app:1234567890"]);
    expect(document.apps[0].error).toMatch(/Timed out/);
    expect(document.slugs[0].activeInstalls).toBe(100);
  });

  it("refuses a snapshot with no surfaces rather than writing an empty document", async () => {
    await expect(snapshot(ctx, params(), readers())).rejects.toThrow(/at least one surface/);
  });

  it("takes totals from the date dimension, not by summing queries", async () => {
    // The real capture path, not an injected reader. Search Console withholds
    // low-volume queries, so the query rows deliberately sum to less than the
    // date rows; the totals must follow the date rows.
    const query = vi.fn(async (request: any) => {
      const dimension = request.requestBody.dimensions[0];
      if (dimension === "date") {
        return { data: { rows: [
          { keys: ["2026-09-01"], clicks: 3, impressions: 400, ctr: 0.0075, position: 20 },
          { keys: ["2026-09-02"], clicks: 2, impressions: 238, ctr: 0.008, position: 4 },
        ] } };
      }
      return { data: { rows: [{ keys: ["one"], clicks: 3, impressions: 270, ctr: 0.011, position: 9 }] } };
    });
    const clients = { searchConsole: { searchanalytics: { query } } } as unknown as GoogleClients;
    const authed: ToolContext = { getClients: () => clients, getAuthenticatedClients: () => clients };

    const result = await snapshot(authed, params({ properties: ["https://example.com/"] }), { now: NOW });

    const totals = (result.structuredContent as any).properties[0].totals;
    expect(totals.clicks).toBe(5);
    expect(totals.impressions).toBe(638);
    // Impression-weighted, not a plain mean of 20 and 4.
    expect(totals.position).toBeCloseTo((20 * 400 + 4 * 238) / 638, 6);
    expect(totals.daysWithData).toBe(2);
  });

  it("reports position as unknown rather than zero when there are no impressions", async () => {
    const query = vi.fn(async () => ({ data: { rows: [] } }));
    const clients = { searchConsole: { searchanalytics: { query } } } as unknown as GoogleClients;
    const authed: ToolContext = { getClients: () => clients, getAuthenticatedClients: () => clients };

    const result = await snapshot(authed, params({ properties: ["https://example.com/"] }), { now: NOW });

    const totals = (result.structuredContent as any).properties[0].totals;
    expect(totals.position).toBeNull();
    expect(totals.ctr).toBeNull();
    expect(totals.clicks).toBe(0);
  });

  it("writes the document when outPath is given so it can be compared later", async () => {
    const written: Array<{ path: string; data: string }> = [];
    const deps = readers({ writeFile: (path: string, data: string) => void written.push({ path, data }) });

    const result = await snapshot(ctx, params({ slugs: ["akismet"], outPath: "snap.json" }), deps);

    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe("/snapshots/snap.json");
    expect(() => snapshotOutput.parse(JSON.parse(written[0]?.data ?? ""))).not.toThrow();
    expect((result.structuredContent as any).writtenTo).toBe("/snapshots/snap.json");
  });

  it("refuses an outPath that points outside the snapshot directory", async () => {
    const written: Array<{ path: string; data: string }> = [];
    const deps = readers({ writeFile: (path: string, data: string) => void written.push({ path, data }) });

    await expect(snapshot(ctx, params({ slugs: ["akismet"], outPath: "../escape.json" }), deps)).rejects.toThrow(/\/snapshots/);
    expect(written).toHaveLength(0);
  });

  it("leaves an existing snapshot alone rather than truncating it", async () => {
    const written: Array<{ path: string; data: string }> = [];
    const deps = readers({
      writeFile: (path: string, data: string) => void written.push({ path, data }),
      fileExists: () => true,
    });

    await expect(snapshot(ctx, params({ slugs: ["akismet"], outPath: "snap.json" }), deps)).rejects.toThrow(/already exists/);
    expect(written).toHaveLength(0);
  });

  it("replaces an existing snapshot when overwrite is asked for", async () => {
    const written: Array<{ path: string; data: string }> = [];
    const deps = readers({
      writeFile: (path: string, data: string) => void written.push({ path, data }),
      fileExists: () => true,
    });

    const result = await snapshot(ctx, params({ slugs: ["akismet"], outPath: "snap.json", overwrite: true }), deps);

    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe("/snapshots/snap.json");
    expect((result.structuredContent as any).writtenTo).toBe("/snapshots/snap.json");
  });

  it("respects the window length", async () => {
    const deps = readers();

    const result = await snapshot(ctx, params({ properties: ["https://example.com/"], windowDays: 7 }), deps);

    expect((result.structuredContent as Record<string, any>).window).toEqual({ startDate: "2026-08-28", endDate: "2026-09-03" });
  });
});

// Only the structured half of a tool result is read by the capture functions,
// so the text body stays empty here.
function toolResult(structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: "" }], structuredContent };
}

const LISTING: Record<string, unknown> = {
  appId: "1",
  platform: "IOS",
  versionString: "1.4.0",
  appInfoState: "READY_FOR_DISTRIBUTION",
  versionState: "READY_FOR_DISTRIBUTION",
  hasLiveRecord: true,
  hasEditableRecord: false,
  fellBack: false,
  localeCount: 2,
  overLimit: ["en-US keywords"],
  ratings: [{ storefront: "us", source: "itunes-lookup", averageUserRating: 4.5, userRatingCount: 12 }],
  locales: [{
    locale: "en-US",
    indexed: { name: { length: 4 }, subtitle: { length: 12 }, keywords: { length: 101 } },
    promotionalText: { length: 0 },
    description: { length: 300 },
    partial: false,
  }],
  notes: [],
};

// These exercise the real capture functions with the tool behind each surface
// faked, which is the code every other snapshot test replaces wholesale.
describe("surface readers", () => {
  it("maps the listing into the fields the document keeps", async () => {
    const identities: Array<{ appId?: string; bundleId?: string }> = [];
    const listApp = async (input: { appId?: string; bundleId?: string }) => {
      identities.push(input);
      return toolResult({ ...LISTING });
    };

    const result = await snapshot(ctx, params({ apps: ["1234567890"] }), { now: NOW, listApp });

    const document = result.structuredContent as Record<string, any>;
    expect(document.apps[0]).toEqual({
      app: "1234567890",
      appId: "1",
      platform: "IOS",
      versionString: "1.4.0",
      appInfoState: "READY_FOR_DISTRIBUTION",
      versionState: "READY_FOR_DISTRIBUTION",
      hasLiveRecord: true,
      hasEditableRecord: false,
      fellBack: false,
      localeCount: 2,
      overLimit: ["en-US keywords"],
      ratings: [{ storefront: "us", source: "itunes-lookup", averageUserRating: 4.5, userRatingCount: 12 }],
      locales: [{ locale: "en-US", name: 4, subtitle: 12, keywords: 101, promotionalText: 0, description: 300, partial: false }],
      notes: [],
    });
    expect(identities[0]).toMatchObject({ appId: "1234567890" });
    expect(identities[0]?.bundleId).toBeUndefined();

    // An app that is not all digits is a bundle id, and the two are different
    // lookups on the App Store Connect side.
    await snapshot(ctx, params({ apps: ["app.example"] }), { now: NOW, listApp });

    expect(identities[1]).toMatchObject({ bundleId: "app.example" });
    expect(identities[1]?.appId).toBeUndefined();
  });

  it("writes a field the listing no longer carries as undefined, and the document schema still accepts it", async () => {
    const renamed = { ...LISTING };
    delete renamed.overLimit;
    const listApp = async () => toolResult(renamed);

    const result = await snapshot(ctx, params({ apps: ["1234567890"] }), { now: NOW, listApp });

    const document = result.structuredContent as Record<string, any>;
    expect(document.apps[0].overLimit).toBeUndefined();
    // The app side of the schema is loose so older snapshots keep parsing, which
    // is also why a renamed listing field is not caught here.
    expect(() => snapshotOutput.parse(document)).not.toThrow();
  });

  it("spreads the play report for the month the window ends in", async () => {
    const months: Array<string | undefined> = [];
    const readStats = async (input: { packageName: string; month?: string }) => {
      months.push(input.month);
      return toolResult({ packageName: input.packageName, month: input.month, activeDeviceInstalls: 12, lastDatePresent: "2026-09-02" });
    };

    const result = await snapshot(ctx, params({ packages: ["app.example"] }), { now: NOW, readStats });

    const document = result.structuredContent as Record<string, any>;
    expect(months).toEqual(["202609"]);
    expect(document.packages[0]).toEqual({
      package: "app.example",
      packageName: "app.example",
      month: "202609",
      activeDeviceInstalls: 12,
      lastDatePresent: "2026-09-02",
    });
    expect(document.packages[0].fellBackFromMonth).toBeUndefined();
  });

  it("falls back to the previous month across a year boundary and says which was read", async () => {
    const months: Array<string | undefined> = [];
    const readStats = async (input: { packageName: string; month?: string }) => {
      months.push(input.month);
      if (months.length === 1) throw new Error("no reports for 202601 yet");
      return toolResult({ packageName: input.packageName, month: input.month, activeDeviceInstalls: 12, lastDatePresent: "2025-12-31", notes: ["installs are as of the last date present"] });
    };

    // Early January is when the fallback has to cross into the previous year.
    const result = await snapshot(ctx, params({ packages: ["app.example"] }), { now: new Date("2026-01-05T11:30:45Z"), readStats });

    const document = result.structuredContent as Record<string, any>;
    expect(months).toEqual(["202601", "202512"]);
    expect(document.packages[0].fellBackFromMonth).toBe("202601");
    expect(document.packages[0].month).toBe("202512");
    expect(document.packages[0].notes).toEqual([
      "installs are as of the last date present",
      expect.stringContaining("was read instead"),
    ]);
    // A month that has not been emitted yet is not a broken surface.
    expect(document.surfacesWithErrors).toEqual([]);
  });

  it("records the package as unread when neither month can be read", async () => {
    const readStats = async () => { throw new Error("bucket unreachable"); };

    const result = await snapshot(ctx, params({ packages: ["app.example"] }), { now: NOW, readStats });

    const document = result.structuredContent as Record<string, any>;
    expect(document.surfacesWithErrors).toEqual(["package:app.example"]);
    expect(document.packages[0]).toMatchObject({ package: "app.example", error: "bucket unreachable" });
  });

  it("keeps the plugin report as the slug surface", async () => {
    const readPlugin = async (input: { slug: string }) => toolResult({ slug: input.slug, activeInstalls: 5 });

    const result = await snapshot(ctx, params({ slugs: ["akismet"] }), { now: NOW, readPlugin });

    expect((result.structuredContent as Record<string, any>).slugs[0]).toEqual({ slug: "akismet", activeInstalls: 5 });
  });
});
