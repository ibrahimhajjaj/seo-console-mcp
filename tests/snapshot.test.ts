import { describe, expect, it, vi } from "vitest";
import { snapshot } from "../src/snapshot.js";
import { snapshotInput, snapshotOutput } from "../src/schemas.js";
import type { ToolContext } from "../src/registry.js";
import type { GoogleClients } from "../src/google-tools.js";

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
