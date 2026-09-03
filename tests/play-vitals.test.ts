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

  it("says it carries no acquisition data", async () => {
    const { fetchImpl } = router(() => ({ status: 200, body: FRESHNESS }));

    const result = await playVitals(
      playVitalsInput.parse({ packageName: "app.example", metricSets: ["crashRate"] }),
      { fetchImpl, accessToken: "t", now: NOW },
    );

    expect((result.structuredContent as any).notes.join(" ")).toMatch(/no acquisition or conversion data/);
  });
});
