import { describe, expect, it } from "vitest";
import { normalizeBucket, playStoreStats } from "../src/play-store-stats.js";

interface TrafficGroup {
  source: string;
  searchTerm: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  visitors: number;
  acquisitions: number;
  conversionRate: number | null;
}

const INSTALLS_202310 =
  "Date,Package Name,Active Device Installs\r\n" +
  "2023-10-01,app.getpsst,100\r\n" +
  "2023-10-02,app.getpsst,105\r\n" +
  "2023-10-03,app.getpsst,110\r\n";

const TRAFFIC_202310 =
  "Date,Package Name,Traffic source,Search term,UTM source,UTM campaign,Store listing visitors,Store listing acquisitions\r\n" +
  "2023-10-01,app.getpsst,Play search,cool app,,,10,2\r\n" +
  "2023-10-02,app.getpsst,Play search,cool app,,,20,4\r\n" +
  "2023-10-03,app.getpsst,Other,,,,50,1\r\n";

const TRAFFIC_202311_NO_SEARCH =
  "Date,Package Name,Traffic source,Search term,UTM source,UTM campaign,Store listing visitors,Store listing acquisitions\r\n" +
  "2023-11-01,app.getpsst,Other,,,,50,1\r\n" +
  "2023-11-02,app.getpsst,Third-party referrers,,,,10,0\r\n";

function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function reader(files: Record<string, string>) {
  const calls: string[] = [];
  const readReport = async (objectPath: string): Promise<Buffer | null> => {
    calls.push(objectPath);
    for (const [needle, text] of Object.entries(files)) {
      if (objectPath.includes(needle)) return utf16le(text);
    }
    return null;
  };
  return { readReport, calls };
}

function traffic(result: Awaited<ReturnType<typeof playStoreStats>>): TrafficGroup[] {
  return (result.structuredContent as { trafficSources: TrafficGroup[] }).trafficSources;
}

describe("playStoreStats", () => {
  it("decodes UTF-16LE with a BOM and reports installs for the last date present", async () => {
    const { readReport } = reader({
      "installs_app.getpsst_202310": INSTALLS_202310,
      "store_performance_app.getpsst_202310": TRAFFIC_202310,
    });

    const result = await playStoreStats({ packageName: "app.getpsst", month: "202310" }, { readReport });

    expect(result.structuredContent).toMatchObject({ activeDeviceInstalls: 110, lastDatePresent: "2023-10-03" });
  });

  it("groups traffic by source and search term and detects Play search", async () => {
    const { readReport } = reader({
      "installs_app.getpsst_202310": INSTALLS_202310,
      "store_performance_app.getpsst_202310": TRAFFIC_202310,
    });

    const result = await playStoreStats({ packageName: "app.getpsst", month: "202310" }, { readReport });

    expect(result.structuredContent).toMatchObject({ hasPlaySearchRows: true });
    const groups = traffic(result);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.source === "Play search")).toEqual({
      source: "Play search",
      searchTerm: "cool app",
      utmSource: null,
      utmCampaign: null,
      visitors: 30,
      acquisitions: 6,
      // Recomputed from the group totals: averaging the two rows' own rates
      // would weight a 10-visitor day the same as a 20-visitor one.
      conversionRate: 6 / 30,
    });
  });

  it("separates acquisition paths that differ only by UTM campaign", async () => {
    const utmTraffic =
      "Date,Package Name,Traffic source,Search term,UTM source,UTM campaign,Store listing visitors,Store listing acquisitions\r\n" +
      "2023-10-01,app.getpsst,Third-party referrers,,newsletter,launch,40,4\r\n" +
      "2023-10-02,app.getpsst,Third-party referrers,,newsletter,retarget,10,5\r\n";
    const { readReport } = reader({ "store_performance_app.getpsst_202310": utmTraffic });

    const result = await playStoreStats({ packageName: "app.getpsst", month: "202310" }, { readReport });

    const groups = traffic(result);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ utmCampaign: "launch", visitors: 40, conversionRate: 0.1 });
    expect(groups[1]).toMatchObject({ utmCampaign: "retarget", visitors: 10, conversionRate: 0.5 });
  });

  it("flags when no Play search rows are present", async () => {
    const { readReport } = reader({
      "installs_app.getpsst_202311": "Date,Active Device Installs\r\n2023-11-01,115\r\n",
      "store_performance_app.getpsst_202311": TRAFFIC_202311_NO_SEARCH,
    });

    const result = await playStoreStats({ packageName: "app.getpsst", month: "202311" }, { readReport });

    expect(result.structuredContent).toMatchObject({ hasPlaySearchRows: false });
    expect(result.content[0]?.text).toContain("No traffic rows matched");
  });

  it("returns null installs, not zero, when only the traffic report exists", async () => {
    const { readReport } = reader({ "store_performance_app.getpsst_202310": TRAFFIC_202310 });

    const result = await playStoreStats({ packageName: "app.getpsst", month: "202310" }, { readReport });

    expect(result.structuredContent).toMatchObject({ activeDeviceInstalls: null, lastDatePresent: "2023-10-03" });
    expect((result.structuredContent as { notes: string[] }).notes).toContain("Installs report is missing.");
  });

  it("keeps installs when the traffic report is missing", async () => {
    const { readReport } = reader({ "installs_app.getpsst_202310": INSTALLS_202310 });

    const result = await playStoreStats({ packageName: "app.getpsst", month: "202310" }, { readReport });

    expect(result.structuredContent).toMatchObject({ activeDeviceInstalls: 110 });
    expect(traffic(result)).toEqual([]);
    expect((result.structuredContent as { notes: string[] }).notes).toContain("Traffic source report is missing.");
  });

  it("throws when neither report exists", async () => {
    const { readReport } = reader({});

    await expect(playStoreStats({ packageName: "app.getpsst", month: "209901" }, { readReport })).rejects.toThrow(/Neither installs nor store performance/);
  });

  it("reads every month a window touches and filters rows to it", async () => {
    const august =
      "Date,Package Name,Active Device Installs,Daily Device Installs\r\n" +
      "2023-08-30,app.getpsst,90,3\r\n" +
      "2023-08-31,app.getpsst,95,5\r\n";
    const september =
      "Date,Package Name,Active Device Installs,Daily Device Installs\r\n" +
      "2023-09-01,app.getpsst,100,4\r\n" +
      "2023-09-02,app.getpsst,110,6\r\n";
    const { readReport, calls } = reader({
      "installs_app.getpsst_202308": august,
      "installs_app.getpsst_202309": september,
    });

    const result = await playStoreStats(
      { packageName: "app.getpsst", startDate: "2023-08-31", endDate: "2023-09-01" },
      { readReport },
    );

    // Both monthly files must be fetched for a window that straddles them.
    expect(calls.some((path) => path.includes("_202308_"))).toBe(true);
    expect(calls.some((path) => path.includes("_202309_"))).toBe(true);
    const content = result.structuredContent as Record<string, any>;
    // 08-30 and 09-02 are outside the window and must not count.
    expect(content.datesPresent).toEqual(["2023-08-31", "2023-09-01"]);
    expect(content.activeDeviceInstalls).toBe(100);
    expect(content.installsWindowTotals["Daily Device Installs"]).toBe(9);
    expect(content.window).toEqual({ startDate: "2023-08-31", endDate: "2023-09-01" });
  });

  it("refuses a window longer than 24 months before reading anything", async () => {
    const { readReport, calls } = reader({});

    await expect(
      playStoreStats({ packageName: "app.getpsst", startDate: "2024-01-01", endDate: "2026-01-31" }, { readReport }),
    ).rejects.toThrow(/more than 24 months/);
    expect(calls).toEqual([]);
  });

  it("refuses a reversed window instead of reading it as a single month", async () => {
    const { readReport } = reader({});

    await expect(
      playStoreStats({ packageName: "app.getpsst", startDate: "2023-10-07", endDate: "2023-10-01" }, { readReport }),
    ).rejects.toThrow(/startDate must be on or before endDate/);
  });

  it("reads a window that sits exactly on the 24-month cap", async () => {
    const { readReport, calls } = reader({});

    // Failing on the missing reports rather than the cap is what proves the
    // window was accepted.
    await expect(
      playStoreStats({ packageName: "app.getpsst", startDate: "2024-01-01", endDate: "2025-12-31" }, { readReport }),
    ).rejects.toThrow(/Neither installs nor store performance report found/);
    expect(calls.filter((path) => path.startsWith("stats/installs/"))).toHaveLength(24);
  });

  it("keeps every install column rather than only the one it reads", async () => {
    const csv =
      "Date,Package Name,Active Device Installs,Daily Device Uninstalls,Total User Installs\r\n" +
      "2023-10-01,app.getpsst,100,2,500\r\n";
    const { readReport } = reader({ "installs_app.getpsst_202310": csv });

    const result = await playStoreStats({ packageName: "app.getpsst", month: "202310" }, { readReport });

    const latest = (result.structuredContent as { installsLatest: Record<string, unknown> }).installsLatest;
    expect(latest).toMatchObject({ "Daily Device Uninstalls": 2, "Total User Installs": 500, "Active Device Installs": 100 });
  });

  it("says how much of the window is missing rather than implying zero", async () => {
    const csv = "Date,Package Name,Active Device Installs\r\n2023-10-01,app.getpsst,100\r\n";
    const { readReport } = reader({ "installs_app.getpsst_202310": csv });

    const result = await playStoreStats(
      { packageName: "app.getpsst", startDate: "2023-10-01", endDate: "2023-10-07" },
      { readReport },
    );

    expect((result.structuredContent as { notes: string[] }).notes.join(" "))
      .toMatch(/covers 7 days but only 1 have install rows/);
  });

  it("accepts a bucket with or without the gs:// prefix", () => {
    expect(normalizeBucket("pubsite_prod_1234")).toBe("pubsite_prod_1234");
    expect(normalizeBucket("gs://pubsite_prod_1234")).toBe("pubsite_prod_1234");
    expect(normalizeBucket("GS://pubsite_prod_1234/")).toBe("pubsite_prod_1234");
    expect(normalizeBucket("  gs://pubsite_prod_1234  ")).toBe("pubsite_prod_1234");
  });

  it("rejects a bucket that carries a path instead of silently finding nothing", () => {
    expect(() => normalizeBucket("gs://pubsite_prod_1234/stats")).toThrow(/must be a bucket name/);
    expect(() => normalizeBucket("gs://")).toThrow(/must be a bucket name/);
  });

  it("defaults the month to the current UTC month", async () => {
    const { readReport, calls } = reader({});

    await expect(
      playStoreStats({ packageName: "app.getpsst" }, { readReport, now: new Date("2026-07-14T00:00:00Z") }),
    ).rejects.toThrow(/Neither/);
    expect(calls.some((path) => path.includes("app.getpsst_202607_"))).toBe(true);
  });
});

describe("playStoreStats report families", () => {
  it("reads a ratings report and groups it by its dimension column", async () => {
    const ratings =
      "Date,Package Name,Country,Daily Average Rating,Total Average Rating\r\n" +
      "2023-10-01,app.azkarly,US,4.5,4.2\r\n" +
      "2023-10-02,app.azkarly,US,5.0,4.3\r\n" +
      "2023-10-02,app.azkarly,GB,3.0,3.1\r\n";
    const { readReport } = reader({ "ratings_app.azkarly_202310": ratings });

    const result = await playStoreStats(
      { packageName: "app.azkarly", month: "202310", include: ["ratings"], ratingsDimension: "country" } as any,
      { readReport },
    );

    const report = (result.structuredContent as any).ratings;
    expect(report.dimension).toBe("Country");
    expect(report.rows.map((row: any) => row.value)).toEqual(["GB", "US"]);
    // Latest reading per dimension value, not a sum: a rating is not a flow.
    expect(report.rows.find((row: any) => row.value === "US").latest["Total Average Rating"]).toBe(4.3);
  });

  it("treats a missing ratings report as an absence, not a failure", async () => {
    const installs = "Date,Package Name,Active Device Installs\r\n2023-10-01,app.getpsst,100\r\n";
    const { readReport } = reader({ "installs_app.getpsst_202310": installs });

    const result = await playStoreStats(
      { packageName: "app.getpsst", month: "202310", include: ["ratings"] } as any,
      { readReport },
    );

    expect((result.structuredContent as any).ratings).toBeNull();
    expect((result.structuredContent as any).notes.join(" ")).toMatch(/absence rather than a fetch failure/);
    expect((result.structuredContent as any).activeDeviceInstalls).toBe(100);
  });

  it("reads a breakdown dimension instead of the overview file when asked", async () => {
    const byCountry =
      "Date,Package Name,Country,Active Device Installs,Daily Device Installs\r\n" +
      "2023-10-01,app.getpsst,US,80,3\r\n" +
      "2023-10-01,app.getpsst,GB,20,1\r\n";
    const { readReport, calls } = reader({ "installs_app.getpsst_202310_country": byCountry });

    await playStoreStats(
      { packageName: "app.getpsst", month: "202310", installsDimension: "country" } as any,
      { readReport },
    );

    expect(calls.some((path) => path.includes("_202310_country.csv"))).toBe(true);
    expect(calls.some((path) => path.includes("_overview.csv"))).toBe(false);
  });
});

describe("playStoreStats remaining families", () => {
  it("reads the reviews CSV, preserving every column", async () => {
    const reviews =
      "Package Name,Reviewer Language,Star Rating,Review Title,Review Text\r\n" +
      "app.azkarly,en,5,Great,Love it\r\n" +
      "app.azkarly,ar,3,Ok,Fine\r\n";
    const { readReport } = reader({ "reviews_app.azkarly_202310": reviews });

    const result = await playStoreStats(
      { packageName: "app.azkarly", month: "202310", include: ["reviews"] } as any,
      { readReport },
    );

    const rows = (result.structuredContent as any).reviews;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      "Package Name": "app.azkarly",
      "Reviewer Language": "en",
      "Star Rating": "5",
      "Review Title": "Great",
      "Review Text": "Love it",
    });
  });

  it("reads the country breakdown and the cheaper total_ variant when asked", async () => {
    const { readReport, calls } = reader({});

    await playStoreStats(
      { packageName: "app.getpsst", month: "202310", storePerformanceDimension: "country", storePerformanceTotals: true } as any,
      { readReport },
    ).catch(() => undefined);

    expect(calls.some((path) => path.includes("total_store_performance_app.getpsst_202310_country.csv"))).toBe(true);
  });

  it("treats a missing reviews report as an absence, not a failure", async () => {
    const installs = "Date,Package Name,Active Device Installs\r\n2023-10-01,app.getpsst,100\r\n";
    const { readReport } = reader({ "installs_app.getpsst_202310": installs });

    const result = await playStoreStats(
      { packageName: "app.getpsst", month: "202310", include: ["reviews"] } as any,
      { readReport },
    );

    expect((result.structuredContent as any).reviews).toBeNull();
    expect((result.structuredContent as any).notes.join(" ")).toMatch(/absence rather than a fetch failure/);
  });
});
