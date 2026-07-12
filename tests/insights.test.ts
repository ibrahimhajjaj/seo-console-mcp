import { describe, expect, it } from "vitest";
import {
  cannibalization,
  comparePeriods,
  ctrGaps,
  strikingDistance,
  type InsightRow,
} from "../src/insights.js";

function row(keys: string[], impressions: number, clicks: number, ctr: number, position: number): InsightRow {
  return { keys, impressions, clicks, ctr, position };
}

describe("strikingDistance", () => {
  it("returns eligible rows ordered by opportunity", () => {
    const rows = [
      row(["top"], 1_000, 300, 0.3, 3),
      row(["near"], 200, 20, 0.1, 8),
      row(["far"], 150, 8, 0.05, 15),
      row(["beyond"], 2_000, 20, 0.01, 25),
    ];

    expect(strikingDistance(rows).map(({ keys, opportunity }) => ({ keys, opportunity }))).toEqual([
      { keys: ["far"], opportunity: 2_250 },
      { keys: ["near"], opportunity: 1_600 },
    ]);
  });

  it("respects the minimum impressions option", () => {
    const rows = [row(["eligible"], 20, 2, 0.1, 10), row(["excluded"], 19, 2, 0.1, 12)];

    expect(strikingDistance(rows, { minImpressions: 20 }).map(({ keys }) => keys)).toEqual([["eligible"]]);
  });
});

describe("comparePeriods", () => {
  it("returns overlapping and period-only keys with correct deltas", () => {
    const current = [
      row(["growing"], 150, 20, 0.13, 4),
      row(["new"], 60, 6, 0.1, 8),
      row(["falling"], 100, 3, 0.03, 12),
    ];
    const previous = [
      row(["growing"], 100, 10, 0.1, 6),
      row(["falling"], 180, 12, 0.07, 9),
      row(["lost"], 80, 5, 0.06, 7),
    ];

    expect(comparePeriods(current, previous)).toEqual({
      gainers: [
        { keys: ["growing"], clicksCurrent: 20, clicksPrevious: 10, clicksDelta: 10, impressionsDelta: 50, positionDelta: -2 },
        { keys: ["new"], clicksCurrent: 6, clicksPrevious: 0, clicksDelta: 6, impressionsDelta: 60, positionDelta: 0 },
      ],
      losers: [
        { keys: ["falling"], clicksCurrent: 3, clicksPrevious: 12, clicksDelta: -9, impressionsDelta: -80, positionDelta: 3 },
        { keys: ["lost"], clicksCurrent: 0, clicksPrevious: 5, clicksDelta: -5, impressionsDelta: -80, positionDelta: 0 },
      ],
    });
  });
});

describe("ctrGaps", () => {
  it("flags a below-average row using its position bucket mean", () => {
    const rows = [
      row(["low"], 1_000, 20, 0.02, 5.1),
      row(["high"], 1_000, 180, 0.18, 4.8),
    ];

    const gaps = ctrGaps(rows);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ keys: ["low"], impressions: 1_000, ctr: 0.02, position: 5.1, missedClicks: 80 });
    expect(gaps[0]?.expectedCtr).toBeCloseTo(0.1);
  });

  it("respects minimum impressions", () => {
    const rows = [
      row(["small-low"], 99, 1, 0.01, 5),
      row(["large-high"], 1_000, 190, 0.19, 5),
    ];

    expect(ctrGaps(rows, { minImpressions: 100 })).toEqual([]);
  });
});

describe("cannibalization", () => {
  it("groups qualifying pages and omits incomplete or single-page queries", () => {
    const rows = [
      row(["shared", "/secondary"], 30, 3, 0.08, 8),
      row(["shared", "/primary"], 90, 12, 0.05, 5),
      row(["single", "/only"], 200, 20, 0.04, 4),
      row(["below", "/one"], 20, 2, 0.07, 7),
      row(["below", "/two"], 9, 1, 0.09, 9),
      row(["missing-page"], 500, 50, 0.02, 2),
    ];

    expect(cannibalization(rows)).toEqual([
      {
        query: "shared",
        pages: [
          { page: "/primary", impressions: 90, clicks: 12, position: 5 },
          { page: "/secondary", impressions: 30, clicks: 3, position: 8 },
        ],
      },
    ]);
  });
});
