import { describe, expect, it, vi } from "vitest";
import { wporgPlugin } from "../src/wporg.js";
import { wporgPluginInput } from "../src/schemas.js";

function params(slug: string, overrides: Record<string, unknown> = {}) {
  // The stats endpoints are off by default here so the existing cases stay
  // single-request; the ones that need them opt in.
  return wporgPluginInput.parse({ slug, downloadDays: 0, includeVersionDistribution: false, ...overrides });
}

// Routes each wp.org endpoint separately: the info API, the download history,
// the historical summary and the version distribution are four different
// services and a fake that answers all of them identically proves nothing.
function routedFetch(routes: { info?: unknown; history?: unknown; summary?: unknown; versions?: unknown; status?: Record<string, number> }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const pick = (key: keyof typeof routes, body: unknown) => new Response(JSON.stringify(body), { status: routes.status?.[key as string] ?? 200 });
    if (url.includes("plugins/info")) return pick("info", routes.info ?? { name: "Akismet", added: "2005-10-19", short_description: "x", icons: { "1x": "i" } });
    if (url.includes("historical_summary")) return pick("summary", routes.summary ?? { today: "10", all_time: "1000" });
    if (url.includes("downloads.php")) return pick("history", routes.history ?? { "2026-09-01": "5", "2026-09-02": "7" });
    if (url.includes("stats/plugin")) return pick("versions", routes.versions ?? { "5.7": 57.74, other: 17.06 });
    return new Response("not found", { status: 404 });
  });
}

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("wporgPlugin", () => {
  it("maps the plugin fields and encodes the slug", async () => {
    const fetchImpl = fetchReturning({
      name: "Akismet Anti-spam",
      version: "5.3",
      active_installs: 5_000_000,
      downloaded: 90_000_000,
      num_ratings: 900,
      rating: 92,
      support_threads: 10,
      support_threads_resolved: 8,
      tested: "6.5",
      added: "2005-10-19",
      last_updated: "2024-01-01 1:00pm GMT",
      short_description: "Spam protection.",
      icons: { "1x": "https://ps.w.org/akismet/icon.png" },
      tags: { spam: "spam", comments: "comments" },
    });

    const output = await wporgPlugin(params("akismet"), { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("action=plugin_information");
    expect(String(url)).toContain("request%5Bslug%5D=akismet");
    expect(output.structuredContent).toMatchObject({
      slug: "akismet",
      name: "Akismet Anti-spam",
      activeInstalls: 5_000_000,
      downloaded: 90_000_000,
      rating: 92,
      supportThreads: 10,
      supportThreadsResolved: 8,
      tags: ["spam", "comments"],
      possiblyLagging: false,
    });
  });

  it("errors on an unknown slug that returns false", async () => {
    const fetchImpl = fetchReturning(false);

    await expect(wporgPlugin(params("does-not-exist"), { fetchImpl })).rejects.toThrow(/No WordPress\.org plugin found/i);
  });

  it("errors on a non-200 response", async () => {
    const fetchImpl = fetchReturning({}, 503);

    await expect(wporgPlugin(params("akismet"), { fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it("flags a freshly added plugin as possibly lagging without altering the numbers", async () => {
    const fetchImpl = fetchReturning({
      name: "Lucid Search Replace",
      version: "1.0.0",
      active_installs: 0,
      downloaded: 3,
      added: "2026-07-13",
      last_updated: "2026-07-13 9:00am GMT",
      short_description: "",
      icons: {},
      tags: {},
    });

    const output = await wporgPlugin(params("lucid-search-replace"), {
      fetchImpl,
      now: new Date("2026-07-14T00:00:00Z"),
    });

    expect(output.structuredContent).toMatchObject({ slug: "lucid-search-replace", downloaded: 3, possiblyLagging: true });
    expect(output.content[0]?.text).toContain("under-reports fresh plugins");
  });

  it("keeps the full ratings histogram, not just the average", async () => {
    const fetchImpl = routedFetch({ info: { name: "P", added: "2015-01-01", short_description: "x", icons: { "1x": "i" }, rating: 90, num_ratings: 1186, ratings: { "5": 1033, "4": 67, "3": 16, "2": 13, "1": 57 } } });

    const output = await wporgPlugin(params("p"), { fetchImpl });

    expect((output.structuredContent as { ratings: Record<string, number> }).ratings)
      .toEqual({ "1": 57, "2": 13, "3": 16, "4": 67, "5": 1033 });
  });

  it("fetches daily downloads, the summary and the version split", async () => {
    const fetchImpl = routedFetch({});

    const output = await wporgPlugin(params("p", { downloadDays: 5, includeVersionDistribution: true }), { fetchImpl });
    const content = output.structuredContent as Record<string, any>;

    expect(content.dailyDownloads).toEqual([
      { date: "2026-09-01", downloads: 5 },
      { date: "2026-09-02", downloads: 7 },
    ]);
    expect(content.downloadSummary).toEqual({ today: 10, all_time: 1000 });
    expect(content.versionDistribution[0]).toEqual({ version: "5.7", percentage: 57.74 });
    expect(content.activeInstallsIsBucketed).toBe(true);
  });

  it("treats a failed stats endpoint as unknown rather than zero, and keeps the plugin data", async () => {
    const fetchImpl = routedFetch({ status: { history: 500, versions: 503 } });

    const output = await wporgPlugin(params("p", { downloadDays: 5, includeVersionDistribution: true }), { fetchImpl });
    const content = output.structuredContent as Record<string, any>;

    expect(content.name).toBe("Akismet");
    expect(content.dailyDownloads).toBeNull();
    expect(content.versionDistribution).toBeNull();
    expect(content.notes.join(" ")).toMatch(/unknown rather than zero/);
    expect(content.notes.join(" ")).toMatch(/unknown rather than absent/);
  });

  it("ignores a junk download response rather than reading it as data", async () => {
    // wp.org returns junk for malformed requests instead of an error.
    const fetchImpl = routedFetch({ history: ["not", "a", "date map"] });

    const output = await wporgPlugin(params("p", { downloadDays: 5 }), { fetchImpl });

    expect((output.structuredContent as { dailyDownloads: unknown }).dailyDownloads).toBeNull();
    expect((output.structuredContent as { notes: string[] }).notes.join(" ")).toMatch(/not a date-keyed object/);
  });

  it("does not flag an established plugin with a missing icon", async () => {
    const fetchImpl = fetchReturning({ name: "Old Plugin", added: "2015-01-01", short_description: "Does things.", icons: {} });

    const output = await wporgPlugin(params("old-plugin"), { fetchImpl, now: new Date("2026-07-14T00:00:00Z") });

    expect(output.structuredContent).toMatchObject({ possiblyLagging: false });
  });
});
