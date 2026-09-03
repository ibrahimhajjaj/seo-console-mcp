import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { generateKeyPairSync } from "node:crypto";
import { appStoreSales } from "../src/app-store-sales.js";
import { appStoreSalesInput, appStoreSalesOutput } from "../src/schemas.js";
import type { AscCredentials } from "../src/app-store-listing.js";

function credentials(): AscCredentials {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { keyId: "K", issuerId: "I", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

const TSV = [
  "Provider\tSKU\tTitle\tUnits\tCountry Code",
  "APPLE\tpsst\tPsst\t1\tNL",
  "APPLE\tzad-ios\tZad\t2\tPK",
  "APPLE\tzad-ios\tZad\t1\tSA",
].join("\n");

function gzipResponding(tsv: string) {
  return vi.fn(async () => new Response(gzipSync(Buffer.from(tsv, "utf8")), { status: 200 }));
}

describe("appStoreSales", () => {
  it("gunzips the tab-delimited report and groups units by SKU and territory", async () => {
    const fetchImpl = gzipResponding(TSV);

    const result = await appStoreSales(
      appStoreSalesInput.parse({ reportDate: "2026-08-30" }),
      { fetchImpl, credentials: credentials(), vendorNumber: "123" },
    );
    const content = result.structuredContent as any;

    expect(content.totalUnits).toBe(4);
    expect(content.apps[0]).toEqual({ sku: "zad-ios", title: "Zad", units: 3, territories: { PK: 2, SA: 1 } });
    expect(content.apps[1]).toMatchObject({ sku: "psst", units: 1, territories: { NL: 1 } });
    // Raw rows are opt-in so a summary call stays small.
    expect(content.rows).toEqual([]);
    expect(() => appStoreSalesOutput.parse(content)).not.toThrow();
  });

  it("treats a period with no sales as an absence, not an error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ detail: "There were no sales for the date specified." }] }), { status: 404 }));

    const result = await appStoreSales(
      appStoreSalesInput.parse({ reportDate: "2026-08-31" }),
      { fetchImpl, credentials: credentials(), vendorNumber: "123" },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ hasData: false, totalUnits: 0, apps: [] });
    expect((result.structuredContent as any).notes.join(" ")).toMatch(/absence of sales.*not a failed request/);
  });

  it("names the role requirement when the key is rejected", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));

    await expect(appStoreSales(
      appStoreSalesInput.parse({}),
      { fetchImpl, credentials: credentials(), vendorNumber: "123" },
    )).rejects.toThrow(/Sales and Reports role|Admin, Finance, or Sales and Reports/);
  });

  it("requires a vendor number and says where to find it", async () => {
    const saved = process.env.SEO_MCP_ASC_VENDOR_NUMBER;
    delete process.env.SEO_MCP_ASC_VENDOR_NUMBER;
    try {
      await expect(appStoreSales(appStoreSalesInput.parse({}), { fetchImpl: gzipResponding(TSV), credentials: credentials() }))
        .rejects.toThrow(/Payments and Financial Reports/);
    } finally {
      if (saved !== undefined) process.env.SEO_MCP_ASC_VENDOR_NUMBER = saved;
    }
  });

  it("defaults to a date Apple has actually published", async () => {
    const fetchImpl = gzipResponding(TSV);

    await appStoreSales(
      appStoreSalesInput.parse({}),
      { fetchImpl, credentials: credentials(), vendorNumber: "123", now: new Date("2026-09-03T00:00:00Z") },
    );

    // Daily reports land the next day, so today is never available.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("2026-09-01");
  });
});
