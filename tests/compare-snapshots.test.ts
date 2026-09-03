import { describe, expect, it } from "vitest";
import { compareSnapshots } from "../src/compare-snapshots.js";
import { compareSnapshotsInput, compareSnapshotsOutput } from "../src/schemas.js";

function row(page: string, position: number, impressions: number) {
  return { rank: 1, keys: { page }, clicks: 1, impressions, ctr: 0.1, position };
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    takenAt: "2026-08-01T10:00Z",
    windowDays: 28,
    window: { startDate: "2026-07-05", endDate: "2026-08-01" },
    properties: [{
      siteUrl: "https://example.com/",
      totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
      topQueries: { rows: [], truncated: false },
      topPages: { rows: [row("https://example.com/a", 8, 500), row("https://example.com/b", 12, 20)], truncated: false },
    }],
    apps: [{ app: "123", versionString: "1.0.0", localeCount: 1, hasEditableRecord: false, ratings: [{ storefront: "us", averageUserRating: 4.5, userRatingCount: 10 }] }],
    packages: [{ package: "app.example", activeDeviceInstalls: 10, lastDatePresent: "2026-07-30" }],
    slugs: [{ slug: "akismet", activeInstalls: 100, downloaded: 500, rating: 90, numRatings: 3 }],
    surfacesWithErrors: [],
    ...overrides,
  };
}

function compare(from: unknown, to: unknown, overrides: Record<string, unknown> = {}) {
  const files: Record<string, string> = { "/from.json": JSON.stringify(from), "/to.json": JSON.stringify(to) };
  return compareSnapshots(
    compareSnapshotsInput.parse({ from: "/from.json", to: "/to.json", ...overrides }),
    { readDocument: (path) => files[path] ?? (() => { throw new Error("missing"); })() },
  );
}

describe("compareSnapshots", () => {
  it("reports deltas across every surface", async () => {
    const later = document({
      takenAt: "2026-08-15T10:00Z",
      properties: [{
        siteUrl: "https://example.com/",
        totals: { clicks: 150, impressions: 1200, ctr: 0.125, position: 7, daysWithData: 28, firstIncompleteDate: null },
        topQueries: { rows: [], truncated: false },
        topPages: { rows: [row("https://example.com/a", 5, 600), row("https://example.com/b", 9, 25)], truncated: false },
      }],
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
      properties: [{
        siteUrl: "https://example.com/",
        totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
        topQueries: { rows: [], truncated: false },
        // /a has weight and moved 3; /b moved 4 but on 20-25 impressions.
        topPages: { rows: [row("https://example.com/a", 5, 500), row("https://example.com/b", 8, 25)], truncated: false },
      }],
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
      properties: [{
        siteUrl: "https://example.com/",
        totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
        topQueries: { rows: [], truncated: false },
        topPages: { rows: [], truncated: true },
      }],
    });

    const result = await compare(document(), truncated);

    expect((result.structuredContent as Record<string, any>).properties[0].truncatedEitherSide).toBe(true);
  });

  it("lists pages that left the captured top rows rather than dropping them", async () => {
    const later = document({
      properties: [{
        siteUrl: "https://example.com/",
        totals: { clicks: 100, impressions: 1000, ctr: 0.1, position: 8, daysWithData: 28, firstIncompleteDate: null },
        topQueries: { rows: [], truncated: false },
        topPages: { rows: [row("https://example.com/a", 8, 500)], truncated: true },
      }],
    });

    const result = await compare(document(), later);

    expect((result.structuredContent as Record<string, any>).properties[0].droppedOutOfTopPages).toEqual(["https://example.com/b"]);
  });

  it("refuses a file that is not a snapshot document", async () => {
    await expect(compare({ hello: "world" }, document())).rejects.toThrow(/not a snapshot document/);
  });

  it("refuses a file that is not valid JSON", async () => {
    const files: Record<string, string> = { "/from.json": "not json", "/to.json": "{}" };
    await expect(compareSnapshots(
      compareSnapshotsInput.parse({ from: "/from.json", to: "/to.json" }),
      { readDocument: (path) => files[path] as string },
    )).rejects.toThrow(/not valid JSON/);
  });

  it("reports an unreadable path without guessing at its contents", async () => {
    await expect(compareSnapshots(
      compareSnapshotsInput.parse({ from: "/missing.json", to: "/to.json" }),
      { readDocument: () => { throw new Error("ENOENT"); } },
    )).rejects.toThrow(/Could not read the from snapshot/);
  });
});
