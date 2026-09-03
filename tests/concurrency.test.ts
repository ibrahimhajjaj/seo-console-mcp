import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/concurrency.js";
import { mapWithConcurrency as reExported } from "../src/audit-site.js";

function deferred(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("returns results in input order however the work finishes", async () => {
    // The slowest job is first, so a pool that appended on completion rather
    // than assigning by index would return this list backwards.
    const results = await mapWithConcurrency([30, 20, 10, 0], 4, async (delay) => {
      await deferred(delay);
      return delay;
    });

    expect(results).toEqual([30, 20, 10, 0]);
  });

  it("keeps at most the requested number in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(Array.from({ length: 6 }, (_, index) => index), 2, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await deferred(5);
      inFlight -= 1;
      return value;
    });

    expect(maxInFlight).toBe(2);
  });

  it("treats a concurrency below one as one rather than stalling", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency([1, 2, 3], 0, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await deferred(5);
      inFlight -= 1;
      return value;
    });

    expect(maxInFlight).toBe(1);
    expect(results).toEqual([1, 2, 3]);
  });

  it("does no work and resolves for an empty list", async () => {
    let ran = 0;

    const results = await mapWithConcurrency([], 4, async () => {
      ran += 1;
      return ran;
    });

    expect(results).toEqual([]);
    expect(ran).toBe(0);
  });

  it("rejects when a job rejects", async () => {
    await expect(mapWithConcurrency([1, 2], 2, async (value) => {
      if (value === 2) throw new Error("boom");
      return value;
    })).rejects.toThrow(/boom/);
  });

  it("is the same function audit-site re-exports", () => {
    // google-tools imports the pool through audit-site, so dropping that
    // re-export would break a caller this file does not otherwise cover.
    expect(reExported).toBe(mapWithConcurrency);
  });
});
