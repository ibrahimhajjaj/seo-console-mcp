import { describe, expect, it, vi } from "vitest";
import { compareSnapshots } from "../src/compare-snapshots.js";
import { compareSnapshotsInput, compareSnapshotsOutput } from "../src/schemas.js";

function row(page: string, position: number, impressions: number) {
  return { rank: 1, keys: { page }, clicks: 1, impressions, ctr: 0.1, position };
}

function queryRow(query: string, position: number, impressions: number) {
  return { rank: 1, keys: { query }, clicks: 1, impressions, ctr: 0.1, position };
}

const TOTALS = { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null };

function property(topQueries: Array<ReturnType<typeof queryRow>>) {
  return {
    siteUrl: "https://example.com/",
    totals: TOTALS,
    topQueries: { rows: topQueries, truncated: false },
    topPages: { rows: [], truncated: false },
  };
}

function locale(keywords: number) {
  return { locale: "en-US", name: 12, subtitle: 20, keywords, promotionalText: 0, description: 300, partial: false };
}

function app(overrides: Record<string, unknown>) {
  return { app: "123", versionString: "1.0.0", localeCount: 1, hasEditableRecord: false, ratings: [], ...overrides };
}

function source(name: string, visitors: number, acquisitions: number, overrides: Record<string, unknown> = {}) {
  return { source: name, searchTerm: null, utmSource: null, utmCampaign: null, visitors, acquisitions, conversionRate: acquisitions / visitors, ...overrides };
}

function playPackage(trafficSources: Array<ReturnType<typeof source>>, hasPlaySearchRows: boolean) {
  return { package: "app.example", activeDeviceInstalls: 10, lastDatePresent: "2026-07-30", trafficSources, hasPlaySearchRows };
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    takenAt: "2026-08-01T10:00Z",
    windowDays: 28,
    window: { startDate: "2026-07-05", endDate: "2026-08-01" },
    properties: [
      {
        siteUrl: "https://example.com/",
        totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
        topQueries: { rows: [], truncated: false },
        topPages: { rows: [row("https://example.com/a", 8, 500), row("https://example.com/b", 12, 20)], truncated: false },
      },
    ],
    apps: [{ app: "123", versionString: "1.0.0", localeCount: 1, hasEditableRecord: false, ratings: [{ storefront: "us", averageUserRating: 4.5, userRatingCount: 10 }] }],
    packages: [{ package: "app.example", activeDeviceInstalls: 10, lastDatePresent: "2026-07-30" }],
    slugs: [{ slug: "akismet", activeInstalls: 100, downloaded: 500, rating: 90, numRatings: 3 }],
    surfacesWithErrors: [],
    ...overrides,
  };
}

// Paths resolve inside the snapshot directory, so the directory is pinned here
// and the map is keyed by what the resolver produces.
const env = { SEO_MCP_SNAPSHOT_DIR: "/snapshots" };

function compare(from: unknown, to: unknown, overrides: Record<string, unknown> = {}) {
  const files: Record<string, string> = { "/snapshots/from.json": JSON.stringify(from), "/snapshots/to.json": JSON.stringify(to) };
  return compareSnapshots(compareSnapshotsInput.parse({ from: "from.json", to: "to.json", ...overrides }), {
    env,
    readDocument: (path) =>
      files[path] ??
      (() => {
        throw new Error("missing");
      })(),
  });
}

describe("compareSnapshots", () => {
  it("reports deltas across every surface", async () => {
    const later = document({
      takenAt: "2026-08-15T10:00Z",
      properties: [
        {
          siteUrl: "https://example.com/",
          totals: { clicks: 150, impressions: 1200, ctr: 0.125, position: 7, daysWithData: 28, firstIncompleteDate: null },
          topQueries: { rows: [], truncated: false },
          topPages: { rows: [row("https://example.com/a", 5, 600), row("https://example.com/b", 9, 25)], truncated: false },
        },
      ],
      slugs: [{ slug: "akismet", activeInstalls: 120, downloaded: 560, rating: 92, numRatings: 4 }],
    });

    const result = await compare(document(), later);
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.elapsedHours).toBe(336);
    expect(comparison.properties[0].clicks).toMatchObject({ from: 100, to: 150, change: 50 });
    expect(comparison.properties[0].position).toMatchObject({ change: -1 });
    expect(comparison.slugs[0].activeInstalls.change).toBe(20);
    expect(comparison.slugs[0].rating.change).toBe(2);
    expect(() => compareSnapshotsOutput.parse(comparison)).not.toThrow();
  });

  it("keeps low-impression position moves out of the movers list", async () => {
    const later = document({
      properties: [
        {
          siteUrl: "https://example.com/",
          totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
          topQueries: { rows: [], truncated: false },
          // /a has weight and moved 3; /b moved 4 but on 20-25 impressions.
          topPages: { rows: [row("https://example.com/a", 5, 500), row("https://example.com/b", 8, 25)], truncated: false },
        },
      ],
    });

    const result = await compare(document(), later, { minImpressions: 100 });
    const movers = (result.structuredContent as Record<string, any>).properties[0].movers;

    expect(movers).toHaveLength(1);
    expect(movers[0]).toMatchObject({ page: "https://example.com/a", change: -3 });
  });

  it("names a surface that failed on either side so it is not read as a change", async () => {
    const before = document({ surfacesWithErrors: ["package:app.example"], packages: [{ package: "app.example", error: "bucket unreachable" }] });

    const result = await compare(before, document());
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.surfacesWithErrors).toEqual(["package:app.example"]);
    expect(comparison.packages[0].comparable).toBe(false);
    expect(result.content[0]?.text).toContain("Do not read these as a change");
  });

  it("marks a property present on only one side as not comparable", async () => {
    const later = document({ properties: [] });

    const result = await compare(document(), later);

    expect((result.structuredContent as Record<string, any>).properties[0]).toMatchObject({ comparable: false });
  });

  it("states plainly that it reports differences, not verdicts", async () => {
    const result = await compare(document(), document());

    expect(result.content[0]?.text).toContain("differences, not verdicts");
    // The CLI emits structuredContent only, so the caveat must survive there too.
    expect((result.structuredContent as Record<string, any>).notes.join(" ")).toContain("differences, not verdicts");
  });

  it("says so when the two documents are passed in the wrong order", async () => {
    const later = document({ takenAt: "2026-08-15T10:00Z" });

    const result = await compare(later, document());
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.elapsedHours).toBe(-336);
    expect(comparison.argumentsReversed).toBe(true);
    expect(comparison.notes.join(" ")).toMatch(/sign reversed/);
    expect(result.content[0]?.text).toMatch(/sign reversed/);
  });

  it("prints apps and does not claim full coverage when a surface is one-sided", async () => {
    const later = document({ packages: [] });

    const result = await compare(document(), later);

    expect(result.content[0]?.text).toContain("- app 123:");
    expect(result.content[0]?.text).toContain("package app.example: not comparable");
    expect(result.content[0]?.text).not.toContain("Every surface was captured on both sides");
  });

  it("reads truncation from the top-row lists, not the date totals", async () => {
    const truncated = document({
      properties: [
        {
          siteUrl: "https://example.com/",
          totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
          topQueries: { rows: [], truncated: false },
          topPages: { rows: [], truncated: true },
        },
      ],
    });

    const result = await compare(document(), truncated);

    expect((result.structuredContent as Record<string, any>).properties[0].truncatedEitherSide).toBe(true);
  });

  it("lists pages that left the captured top rows rather than dropping them", async () => {
    const later = document({
      properties: [
        {
          siteUrl: "https://example.com/",
          totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
          topQueries: { rows: [], truncated: false },
          topPages: { rows: [row("https://example.com/a", 8, 500)], truncated: true },
        },
      ],
    });

    const result = await compare(document(), later);

    expect((result.structuredContent as Record<string, any>).properties[0].droppedOutOfTopPages).toEqual(["https://example.com/b"]);
  });

  it("pairs top queries the way it pairs top pages", async () => {
    const before = document({ properties: [property([queryRow("seo mcp", 9, 400), queryRow("search console mcp", 4, 300)])] });
    const after = document({ properties: [property([queryRow("seo mcp", 6, 450)])] });

    const result = await compare(before, after);
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.properties[0].queryMovers).toEqual([{ query: "seo mcp", positionFrom: 9, positionTo: 6, change: -3, impressions: 450 }]);
    expect(comparison.properties[0].droppedOutOfTopQueries).toEqual(["search console mcp"]);
    expect(() => compareSnapshotsOutput.parse(comparison)).not.toThrow();
  });

  it("caps the query movers at the entries that carry the most movement", async () => {
    const before = document({ properties: [property(Array.from({ length: 30 }, (_, index) => queryRow(`q${index}`, 10, 500)))] });
    const after = document({ properties: [property(Array.from({ length: 30 }, (_, index) => queryRow(`q${index}`, 10 + index + 1, 500)))] });

    const result = await compare(before, after);
    const movers = (result.structuredContent as Record<string, any>).properties[0].queryMovers;

    expect(movers).toHaveLength(25);
    expect(movers[0]).toMatchObject({ query: "q29", change: 30 });
  });

  it("reports a listing field that shortened and the limit it no longer crosses", async () => {
    const before = document({ apps: [app({ overLimit: ["en-US keywords"], locales: [locale(101)] })] });
    const after = document({ apps: [app({ overLimit: [], locales: [locale(98)] })] });

    const result = await compare(before, after);
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.apps[0].localesComparable).toBe(true);
    expect(comparison.apps[0].locales[0]).toMatchObject({ locale: "en-US", keywords: { from: 101, to: 98, change: -3 } });
    expect(comparison.apps[0].overLimit).toEqual({ added: [], removed: ["en-US keywords"] });
    expect(() => compareSnapshotsOutput.parse(comparison)).not.toThrow();
  });

  it("marks per-locale lengths not comparable when a document predates them", async () => {
    // The base fixture is an app document from before the lengths were captured.
    const after = document({ apps: [app({ overLimit: ["en-US keywords"], locales: [locale(101)] })] });

    const result = await compare(document(), after);
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.apps[0].localesComparable).toBe(false);
    expect(comparison.apps[0].locales).toEqual([]);
    expect(comparison.apps[0].overLimit).toEqual({ added: [], removed: [] });
    expect(() => compareSnapshotsOutput.parse(comparison)).not.toThrow();
  });

  it("reports a traffic source that only appears on the later side", async () => {
    const before = document({ packages: [playPackage([], false)] });
    const after = document({ packages: [playPackage([source("Google Play search", 200, 40)], true)] });

    const result = await compare(before, after);
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.packages[0].trafficSources).toEqual([
      {
        source: "Google Play search",
        visitors: { from: null, to: 200, change: null },
        acquisitions: { from: null, to: 40, change: null },
        conversionRate: { from: null, to: 0.2, change: null },
      },
    ]);
    expect(comparison.packages[0].hasPlaySearchRows).toEqual({ from: false, to: true });
    expect(() => compareSnapshotsOutput.parse(comparison)).not.toThrow();
  });

  it("keeps search-term rows out of the per-source list", async () => {
    const rows = (visitors: number) => [source("Google Play search", visitors, 10), source("Google Play search", 5, 1, { searchTerm: "psst" })];
    const before = document({ packages: [playPackage(rows(100), true)] });
    const after = document({ packages: [playPackage(rows(160), true)] });

    const result = await compare(before, after);
    const sources = (result.structuredContent as Record<string, any>).packages[0].trafficSources;

    expect(sources).toHaveLength(1);
    expect(sources[0].visitors).toMatchObject({ from: 100, to: 160, change: 60 });
  });

  it("reports the wp.org histogram star by star", async () => {
    const slug = (five: number) => ({ slug: "akismet", activeInstalls: 100, downloaded: 500, rating: 90, numRatings: 3, ratings: { 1: 1, 2: 0, 3: 0, 4: 1, 5: five } });
    const before = document({ slugs: [slug(1)] });
    const after = document({ slugs: [slug(3)] });

    const result = await compare(before, after);
    const comparison = result.structuredContent as Record<string, any>;

    expect(comparison.slugs[0].ratingsHistogram["5"]).toMatchObject({ from: 1, to: 3, change: 2 });
    expect(comparison.slugs[0].ratingsHistogram["1"]).toMatchObject({ from: 1, to: 1, change: 0 });
    // The base fixture predates the histogram, so both sides come back null.
    const older = await compare(document(), document());
    expect((older.structuredContent as Record<string, any>).slugs[0].ratingsHistogram["5"]).toEqual({ from: null, to: null, change: null });
    expect(() => compareSnapshotsOutput.parse(comparison)).not.toThrow();
  });

  it("refuses a file that is not a snapshot document", async () => {
    await expect(compare({ hello: "world" }, document())).rejects.toThrow(/not a snapshot document/);
  });

  it("refuses a file that is not valid JSON without saying how it is wrong", async () => {
    // Unparseable and parseable-but-wrong share one message, so a caller cannot
    // learn the shape of a file from the refusal.
    const files: Record<string, string> = { "/snapshots/from.json": "not json", "/snapshots/to.json": "{}" };
    await expect(compareSnapshots(compareSnapshotsInput.parse({ from: "from.json", to: "to.json" }), { env, readDocument: (path) => files[path] as string })).rejects.toThrow(
      /not a snapshot document/,
    );
  });

  it("reports an unreadable path without guessing at its contents", async () => {
    await expect(
      compareSnapshots(compareSnapshotsInput.parse({ from: "missing.json", to: "to.json" }), {
        env,
        readDocument: () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(/Could not read the from snapshot/);
  });

  it("takes previous and latest instead of two file names", async () => {
    const files: Record<string, string> = {
      "/snapshots/a.json": JSON.stringify(document()),
      "/snapshots/b.json": JSON.stringify(document({ takenAt: "2026-08-15T10:00Z", slugs: [{ slug: "akismet", activeInstalls: 120, downloaded: 560, rating: 92, numRatings: 4 }] })),
    };

    const result = await compareSnapshots(compareSnapshotsInput.parse({ from: "previous", to: "latest" }), {
      env,
      readDir: () => Object.keys(files).map((path) => path.slice("/snapshots/".length)),
      readDocument: (path) => files[path] as string,
    });
    const comparison = result.structuredContent as Record<string, any>;

    // b.json is the newer of the two, so it is the one "latest" resolves to.
    expect(comparison.from.takenAt).toBe("2026-08-01T10:00Z");
    expect(comparison.to.takenAt).toBe("2026-08-15T10:00Z");
    expect(comparison.argumentsReversed).toBe(false);
    expect(comparison.slugs[0].activeInstalls.change).toBe(20);
  });

  it("refuses previous when there is only one snapshot to compare", async () => {
    const files: Record<string, string> = { "/snapshots/a.json": JSON.stringify(document()) };

    await expect(compareSnapshots(compareSnapshotsInput.parse({ from: "previous", to: "latest" }), { env, readDir: () => ["a.json"], readDocument: (path) => files[path] as string })).rejects.toThrow(
      /needs at least two/,
    );
  });

  it("refuses a path outside the snapshot directory before reading anything", async () => {
    const readDocument = vi.fn(() => "{}");

    await expect(compareSnapshots(compareSnapshotsInput.parse({ from: "../evil.json", to: "to.json" }), { env, readDocument })).rejects.toThrow(/\/snapshots/);
    expect(readDocument).not.toHaveBeenCalled();
  });
});
