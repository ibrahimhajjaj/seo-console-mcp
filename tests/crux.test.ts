import { describe, expect, it, vi } from "vitest";
import { cruxFieldData, cruxHistory } from "../src/crux.js";
import { cruxFieldDataInput, cruxFieldDataOutput, cruxHistoryInput, cruxHistoryOutput } from "../src/schemas.js";

const KEY = "test-key";

function responding(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const RECORD = {
  record: {
    key: { origin: "https://example.com" },
    collectionPeriod: { firstDate: { year: 2026, month: 8, day: 3 }, lastDate: { year: 2026, month: 8, day: 30 } },
    metrics: {
      largest_contentful_paint: {
        percentiles: { p75: 1220 },
        histogram: [
          { start: 0, end: 2500, density: 0.85 },
          { start: 2500, density: 0.15 },
        ],
      },
    },
  },
};

const HISTORY = {
  record: {
    key: { origin: "https://example.com" },
    collectionPeriods: [
      { firstDate: { year: 2026, month: 8, day: 1 }, lastDate: { year: 2026, month: 8, day: 28 } },
      { firstDate: { year: 2026, month: 8, day: 8 }, lastDate: { year: 2026, month: 9, day: 4 } },
    ],
    metrics: {
      largest_contentful_paint: { percentilesTimeseries: { p75s: [1220, "NaN"] } },
    },
  },
};

describe("cruxFieldData", () => {
  it("reads p75s and histogram bins for an origin", async () => {
    const fetchImpl = responding(RECORD);

    const result = await cruxFieldData(cruxFieldDataInput.parse({ origin: "https://example.com", formFactor: "PHONE" }), { fetchImpl, apiKey: KEY });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("records:queryRecord");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ origin: "https://example.com", formFactor: "PHONE" });
    expect(result.structuredContent).toMatchObject({
      hasData: true,
      source: "field_crux_daily",
      collectionPeriod: { firstDate: "2026-08-03", lastDate: "2026-08-30" },
    });
    const metrics = (result.structuredContent as { metrics: Record<string, any> }).metrics;
    expect(metrics.largest_contentful_paint.p75).toBe(1220);
    // An open-ended final bin has no end, which is null rather than 0.
    expect(metrics.largest_contentful_paint.histogram[1]).toEqual({ start: 2500, end: null, density: 0.15 });
    expect(() => cruxFieldDataOutput.parse(result.structuredContent)).not.toThrow();
  });

  it("treats a 404 as an absence of data, not a failure and not zero", async () => {
    const fetchImpl = responding({ error: { code: 404, status: "NOT_FOUND" } }, 404);

    const result = await cruxFieldData(cruxFieldDataInput.parse({ origin: "https://tiny.example" }), { fetchImpl, apiKey: KEY });

    expect(result.structuredContent).toMatchObject({ hasData: false, metrics: {} });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { notes: string[] }).notes.join(" ")).toMatch(/absence of data rather than a fault/);
    expect(() => cruxFieldDataOutput.parse(result.structuredContent)).not.toThrow();
  });

  it("reports a rejected key distinctly from missing data", async () => {
    const fetchImpl = responding({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);

    await expect(cruxFieldData(cruxFieldDataInput.parse({ origin: "https://example.com" }), { fetchImpl, apiKey: KEY })).rejects.toThrow(/rejected the key/);
  });

  it("refuses a request with no target rather than posting an empty body", async () => {
    const fetchImpl = responding(RECORD);

    await expect(cruxFieldData(cruxFieldDataInput.parse({}), { fetchImpl, apiKey: KEY })).rejects.toThrow(/exactly one of origin or url/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses both targets rather than silently measuring the origin", async () => {
    const fetchImpl = responding(RECORD);

    await expect(cruxFieldData(cruxFieldDataInput.parse({ origin: "https://example.com", url: "https://example.com/a" }), { fetchImpl, apiKey: KEY })).rejects.toThrow(/exactly one of origin or url/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a key and says which variable to set", async () => {
    const fetchImpl = responding(RECORD);
    const saved = { crux: process.env.SEO_MCP_CRUX_KEY, ps: process.env.SEO_MCP_PAGESPEED_KEY };
    delete process.env.SEO_MCP_CRUX_KEY;
    delete process.env.SEO_MCP_PAGESPEED_KEY;
    try {
      await expect(cruxFieldData(cruxFieldDataInput.parse({ origin: "https://example.com" }), { fetchImpl })).rejects.toThrow(/SEO_MCP_CRUX_KEY/);
    } finally {
      if (saved.crux !== undefined) process.env.SEO_MCP_CRUX_KEY = saved.crux;
      if (saved.ps !== undefined) process.env.SEO_MCP_PAGESPEED_KEY = saved.ps;
    }
  });
});

describe("cruxHistory", () => {
  it("keeps the series aligned with its periods and nulls the gaps", async () => {
    const fetchImpl = responding(HISTORY);

    const result = await cruxHistory(cruxHistoryInput.parse({ origin: "https://example.com", collectionPeriodCount: 2 }), { fetchImpl, apiKey: KEY });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("records:queryHistoryRecord");
    expect(JSON.parse(String((init as RequestInit).body)).collectionPeriodCount).toBe(2);
    const content = result.structuredContent as Record<string, any>;
    expect(content.periodCount).toBe(2);
    expect(content.collectionPeriods[1]).toEqual({ firstDate: "2026-08-08", lastDate: "2026-09-04" });
    // "NaN" marks a period with too few samples; it must stay in place as null
    // so the series still lines up with collectionPeriods.
    expect(content.metrics.largest_contentful_paint.p75s).toEqual([1220, null]);
    expect(() => cruxHistoryOutput.parse(content)).not.toThrow();
  });

  it("refuses a request with no target rather than posting an empty body", async () => {
    const fetchImpl = responding(HISTORY);

    await expect(cruxHistory(cruxHistoryInput.parse({}), { fetchImpl, apiKey: KEY })).rejects.toThrow(/exactly one of origin or url/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses both targets rather than silently measuring the origin", async () => {
    const fetchImpl = responding(HISTORY);

    await expect(cruxHistory(cruxHistoryInput.parse({ origin: "https://example.com", url: "https://example.com/a" }), { fetchImpl, apiKey: KEY })).rejects.toThrow(/exactly one of origin or url/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("warns that consecutive periods overlap", async () => {
    const fetchImpl = responding(HISTORY);

    const result = await cruxHistory(cruxHistoryInput.parse({ origin: "https://example.com" }), { fetchImpl, apiKey: KEY });

    expect((result.structuredContent as { notes: string[] }).notes.join(" ")).toMatch(/overlap by three weeks/);
    expect(result.content[0]?.text).toMatch(/not an independent change/);
  });
});
