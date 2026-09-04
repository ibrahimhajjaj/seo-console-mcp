import { describe, expect, it } from "vitest";
import { listSnapshotsTool } from "../src/list-snapshots.js";
import { listSnapshotsInput, listSnapshotsOutput } from "../src/schemas.js";
import { listSnapshots } from "../src/snapshot-paths.js";

// The directory is pinned and both filesystem reads are injected, so a test run
// never reaches a real path.
const env = { SEO_MCP_SNAPSHOT_DIR: "/snapshots" };

function document(takenAt: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    takenAt,
    windowDays: 28,
    window: { startDate: "2026-08-07", endDate: "2026-09-03" },
    properties: [
      {
        siteUrl: "https://example.com/",
        totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 5, daysWithData: 28, firstIncompleteDate: null },
        topQueries: { rows: [], truncated: false },
        topPages: { rows: [], truncated: false },
      },
    ],
    apps: [],
    packages: [],
    slugs: [{ slug: "akismet", activeInstalls: 100, downloaded: 500, rating: 90, numRatings: 3 }],
    surfacesWithErrors: [],
    ...overrides,
  });
}

function directory(files: Record<string, string>) {
  return {
    env,
    // readdirSync yields bare names, not paths.
    readDir: () => Object.keys(files).map((path) => path.slice("/snapshots/".length)),
    readFile: (path: string) =>
      files[path] ??
      (() => {
        throw new Error("ENOENT");
      })(),
  };
}

function run(files: Record<string, string>, params: Record<string, unknown> = {}) {
  return listSnapshotsTool(listSnapshotsInput.parse(params), directory(files));
}

describe("list_snapshots", () => {
  it("lists what is on disk newest first with the surface counts", async () => {
    const result = await run({
      "/snapshots/older.json": document("2026-08-01T10:00Z"),
      "/snapshots/newer.json": document("2026-09-03T11:30Z"),
    });
    const listing = result.structuredContent as Record<string, any>;

    expect(listing.directory).toBe("/snapshots");
    expect(listing.total).toBe(2);
    expect(listing.truncated).toBe(false);
    expect(listing.snapshots.map((entry: any) => entry.name)).toEqual(["newer.json", "older.json"]);
    expect(listing.snapshots[0]).toMatchObject({
      path: "/snapshots/newer.json",
      takenAt: "2026-09-03T11:30Z",
      windowDays: 28,
      surfaces: { properties: 1, apps: 0, packages: 0, slugs: 1 },
    });
    expect(result.content[0]?.text).toContain("2 snapshot(s) in /snapshots");
    expect(() => listSnapshotsOutput.parse(listing)).not.toThrow();
  });

  it("reports a file that will not parse rather than hiding it", async () => {
    // A name the caller expects to find must not read as absent just because
    // the file behind it is broken.
    const result = await run({
      "/snapshots/good.json": document("2026-09-03T11:30Z"),
      "/snapshots/broken.json": "not json",
      "/snapshots/wrong.json": JSON.stringify({ hello: "world" }),
    });
    const listing = result.structuredContent as Record<string, any>;

    expect(listing.total).toBe(3);
    // Both unreadable files sort behind the one with a timestamp.
    expect(listing.snapshots.map((entry: any) => entry.name)).toEqual(["good.json", "broken.json", "wrong.json"]);
    expect(listing.snapshots[1]).toMatchObject({ takenAt: null, windowDays: null, error: expect.stringContaining("not a snapshot document") });
    expect(listing.snapshots[2].error).toContain("not a snapshot document");
    expect(result.content[0]?.text).toContain("- broken.json: is not a snapshot document");
    expect(() => listSnapshotsOutput.parse(listing)).not.toThrow();
  });

  it("ignores files that are not snapshots by name", async () => {
    const result = await run({ "/snapshots/notes.txt": "hello", "/snapshots/a.json": document("2026-09-03T11:30Z") });

    expect((result.structuredContent as Record<string, any>).snapshots.map((entry: any) => entry.name)).toEqual(["a.json"]);
  });

  it("says plainly that an empty directory holds no history", async () => {
    const result = await run({});
    const listing = result.structuredContent as Record<string, any>;

    expect(listing.snapshots).toEqual([]);
    expect(listing.total).toBe(0);
    expect(result.content[0]?.text).toContain("No snapshots in /snapshots");
    expect(() => listSnapshotsOutput.parse(listing)).not.toThrow();
  });

  it("treats a directory that does not exist as an empty history", () => {
    // Nothing has been captured yet, which is not a failure to report.
    expect(
      listSnapshots({
        env,
        readDir: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual([]);
  });

  it("says when the list was cut at the limit", async () => {
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`/snapshots/${index}.json`, document(`2026-09-0${index + 1}T10:00Z`)]));

    const result = await run(files, { limit: 2 });
    const listing = result.structuredContent as Record<string, any>;

    expect(listing.total).toBe(5);
    expect(listing.truncated).toBe(true);
    expect(listing.snapshots.map((entry: any) => entry.name)).toEqual(["4.json", "3.json"]);
    expect(result.content[0]?.text).toContain("showing the 2 most recent");
    expect(() => listSnapshotsOutput.parse(listing)).not.toThrow();
  });
});
