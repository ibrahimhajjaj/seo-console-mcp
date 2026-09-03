import { describe, expect, it, vi } from "vitest";
import { playVitals } from "../src/play-vitals.js";
import { playVitalsInput, playVitalsOutput } from "../src/schemas.js";

const NOW = new Date("2026-09-03T00:00:00Z");

function router(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = handler(url, init ?? {});
    return new Response(JSON.stringify(body), { status });
  });
  return { fetchImpl, calls };
}

const FRESHNESS = {
  freshnessInfo: {
    freshnesses: [
      { aggregationPeriod: "HOURLY", latestEndTime: { year: 2026, month: 9, day: 2, hours: 14 } },
      { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 1 } },
    ],
  },
};

describe("playVitals", () => {
  it("clamps the window to the API's own freshness instead of today", async () => {
    const { fetchImpl, calls } = router((url) => url.endsWith(":query")
      ? { status: 200, body: { rows: [{ startTime: { year: 2026, month: 9, day: 1 }, metrics: [] }] } }
      : { status: 200, body: FRESHNESS });

    const result = await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate"], days: 14 }),
      { fetchImpl, accessToken: "t", now: NOW },
    );

    const query = calls.find((call) => call.url.endsWith(":query"))?.body as any;
    // Asking through today is refused by the API; the freshness date is the cap.
    expect(query.timelineSpec.endTime).toEqual({ year: 2026, month: 9, day: 1 });
    expect((result.structuredContent as any).notes.join(" ")).toMatch(/fresh only through 2026-09-01/);
    expect((result.structuredContent as any).metricSets.crashRate.latestDataAt).toBe("2026-09-01");
    expect(() => playVitalsOutput.parse(result.structuredContent)).not.toThrow();
  });

  it("reports zero rows against a known date rather than as a bare zero", async () => {
    const { fetchImpl } = router((url) => url.endsWith(":query")
      ? { status: 200, body: { rows: [] } }
      : { status: 200, body: FRESHNESS });

    const result = await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["anrRate"] }),
      { fetchImpl, accessToken: "t", now: NOW },
    );

    expect((result.structuredContent as any).metricSets.anrRate).toMatchObject({ available: true, rowCount: 0, latestDataAt: "2026-09-01" });
  });

  it("issues every metric set's freshness read before answering any of them", async () => {
    const seen: string[] = [];
    let releaseGets = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseGets = resolve; });
    let bothArrived = (): void => {};
    const arrived = new Promise<void>((resolve) => { bothArrived = resolve; });
    const isQuery = (url: string): boolean => url.endsWith(":query");

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (isQuery(url)) return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      // The first freshness read is held until the second has been issued, so a
      // reader that took the sets one at a time would never reach this twice.
      if (seen.filter((entry) => !isQuery(entry)).length === 2) bothArrived();
      await gate;
      return new Response(JSON.stringify(FRESHNESS), { status: 200 });
    });

    const pending = playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate", "anrRate"] }),
      { fetchImpl, accessToken: "t", now: NOW },
    );

    await arrived;
    const gets = seen.filter((url) => !isQuery(url));
    expect(gets.some((url) => url.includes("crashRateMetricSet"))).toBe(true);
    expect(gets.some((url) => url.includes("anrRateMetricSet"))).toBe(true);
    // Neither query can have gone out: both depend on their own freshness answer.
    expect(seen.filter(isQuery)).toHaveLength(0);

    releaseGets();
    const result = await pending;

    // Overlapping calls must not reorder the document.
    expect(Object.keys((result.structuredContent as any).metricSets)).toEqual(["crashRate", "anrRate"]);
  });

  it("carries the API's own message through instead of a bare status", async () => {
    const { fetchImpl } = router((url) => url.endsWith(":query")
      ? { status: 400, body: { error: { message: "At least one 'metric' should be specified" } } }
      : { status: 200, body: FRESHNESS });

    const result = await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate"] }),
      { fetchImpl, accessToken: "t", now: NOW },
    );

    expect((result.structuredContent as any).metricSets.crashRate.error).toMatch(/At least one 'metric' should be specified/);
  });

  it("keeps the package name a single path segment", async () => {
    const { fetchImpl, calls } = router((url) => url.endsWith(":query")
      ? { status: 200, body: { rows: [] } }
      : { status: 200, body: FRESHNESS });

    await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate"] }),
      { fetchImpl, accessToken: "t", now: NOW },
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.url).toContain("/apps/app.example/");
  });

  it("keeps the row count but withholds the rows unless they were asked for", async () => {
    const { fetchImpl } = router((url) => url.endsWith(":query")
      ? { status: 200, body: { rows: [{ startTime: { year: 2026, month: 9, day: 1 }, metrics: [] }] } }
      : { status: 200, body: FRESHNESS });

    const result = await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate"] }),
      { fetchImpl, accessToken: "t", now: NOW },
    );
    const content = result.structuredContent as any;

    expect(content.metricSets.crashRate).toMatchObject({ available: true, rowCount: 1 });
    expect(content.metricSets.crashRate.rows).toEqual([]);
    expect(content.notes.join(" ")).toMatch(/pass includeRows to see them/);
  });

  it("returns the rows and drops the note when includeRows is set", async () => {
    const { fetchImpl } = router((url) => url.endsWith(":query")
      ? { status: 200, body: { rows: [{ startTime: { year: 2026, month: 9, day: 1 }, metrics: [] }] } }
      : { status: 200, body: FRESHNESS });

    const result = await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate"], includeRows: true }),
      { fetchImpl, accessToken: "t", now: NOW },
    );
    const content = result.structuredContent as any;

    expect(content.metricSets.crashRate.rows).toHaveLength(1);
    expect(content.notes.join(" ")).not.toMatch(/pass includeRows to see them/);
  });

  it("says it carries no acquisition data", async () => {
    const { fetchImpl } = router(() => ({ status: 200, body: FRESHNESS }));

    const result = await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate"] }),
      { fetchImpl, accessToken: "t", now: NOW },
    );

    expect((result.structuredContent as any).notes.join(" ")).toMatch(/no acquisition or conversion data/);
  });
});
