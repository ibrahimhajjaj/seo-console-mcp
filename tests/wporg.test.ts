import { describe, expect, it, vi } from "vitest";
import { wporgPlugin } from "../src/wporg.js";
import { wporgPluginInput } from "../src/schemas.js";

function params(slug: string) {
  return wporgPluginInput.parse({ slug });
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

  it("does not flag an established plugin with a missing icon", async () => {
    const fetchImpl = fetchReturning({ name: "Old Plugin", added: "2015-01-01", short_description: "Does things.", icons: {} });

    const output = await wporgPlugin(params("old-plugin"), { fetchImpl, now: new Date("2026-07-14T00:00:00Z") });

    expect(output.structuredContent).toMatchObject({ possiblyLagging: false });
  });
});
