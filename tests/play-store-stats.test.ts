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
