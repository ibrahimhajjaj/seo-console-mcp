import { describe, expect, it, vi } from "vitest";
import { dateRange, quoteGaql, resolveAdsCredentials } from "../src/google-ads.js";
import { adsCampaigns, adsChanges, adsKeywords, adsQuery, adsSearchTerms, adsUpdate } from "../src/google-ads-tools.js";
import {
  adsCampaignsInput,
  adsCampaignsOutput,
  adsChangesInput,
  adsChangesOutput,
  adsKeywordsInput,
  adsKeywordsOutput,
  adsQueryInput,
  adsSearchTermsInput,
  adsSearchTermsOutput,
  adsUpdateInput,
  adsUpdateOutput,
} from "../src/schemas.js";

const credentials = {
  developerToken: "dev",
  clientId: "id",
  clientSecret: "secret",
  refreshToken: "refresh",
  customerId: "1234567890",
  apiVersion: "v25",
};

// Routes by URL rather than by call order, so the fake cannot depend on a
// sequence the code is free to change.
function router(handler: (url: string, body: any) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const { status = 200, body: responseBody } = handler(url, body);
    return new Response(JSON.stringify(responseBody), { status });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function stream(results: unknown[]) {
  return [{ results }];
}

describe("quoteGaql", () => {
  it("escapes rather than strips, so a target is not silently rewritten", () => {
    // Stripping the apostrophe would search for a different keyword and match
    // nothing, which "exactly one match or refuse" cannot protect against.
    expect(quoteGaql("o'brien backup")).toBe("'o\\'brien backup'");
    expect(quoteGaql("a\\b")).toBe("'a\\\\b'");
    expect(quoteGaql("wordpress backup")).toBe("'wordpress backup'");
  });

  it("refuses a value carrying a newline or control character", () => {
    expect(() => quoteGaql("two\nlines")).toThrow(/control characters/);
  });
});

describe("dateRange", () => {
  it("covers the asked-for window inclusively", () => {
    // GAQL only has LAST_7, LAST_14 and LAST_30 as trailing literals, so any
    // other number has to become an explicit range or the API rejects it.
    expect(dateRange(30, new Date("2026-09-12T00:00:00Z"))).toEqual({ startDate: "2026-08-14", endDate: "2026-09-12" });
    expect(dateRange(1, new Date("2026-09-12T00:00:00Z"))).toEqual({ startDate: "2026-09-12", endDate: "2026-09-12" });
    expect(dateRange(90, new Date("2026-09-12T00:00:00Z"))).toEqual({ startDate: "2026-06-15", endDate: "2026-09-12" });
  });
});

describe("resolveAdsCredentials", () => {
  it("names every missing variable at once instead of one per attempt", () => {
    expect(() => resolveAdsCredentials({})).toThrow(/GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID/);
  });

  it("accepts the account number with dashes, as Google writes it", () => {
    const resolved = resolveAdsCredentials({
      GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
      GOOGLE_ADS_CLIENT_ID: "id",
      GOOGLE_ADS_CLIENT_SECRET: "secret",
      GOOGLE_ADS_REFRESH_TOKEN: "refresh",
      GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
    });

    expect(resolved.customerId).toBe("1234567890");
  });

  it("says a restart is needed, since a server reads its environment once", () => {
    expect(() => resolveAdsCredentials({ GOOGLE_ADS_DEVELOPER_TOKEN: "dev" })).toThrow(/reads its environment once at startup/);
  });
});

describe("ads reads", () => {
  it("returns every keyword row rather than a first page", async () => {
    // Fourteen rows, which is the case that made a console reader report two.
    const rows = Array.from({ length: 14 }, (_, index) => ({
      adGroup: { name: "core" },
      adGroupCriterion: { keyword: { text: `keyword ${index}` }, effectiveCpcBidMicros: "1500000", systemServingStatus: "ELIGIBLE" },
      metrics: { impressions: index, clicks: 0, costMicros: "0" },
    }));
    const { fetchImpl } = router(() => ({ body: stream(rows) }));

    const result = await adsKeywords(adsKeywordsInput.parse({}), { credentials, fetchImpl });
    const content = result.structuredContent as { rowCount: number; keywords: unknown[] };

    expect(content.rowCount).toBe(14);
    expect(content.keywords).toHaveLength(14);
    expect(result.content[0]?.text).toContain("every row, not a first page");
    expect(() => adsKeywordsOutput.parse(content)).not.toThrow();
  });

  it("converts micros to dollars", async () => {
    const { fetchImpl } = router(() => ({
      body: stream([
        {
          campaign: { name: "search-uk", status: "ENABLED" },
          campaignBudget: { amountMicros: "3000000" },
          metrics: { impressions: 10, clicks: 2, costMicros: "1250000", conversions: 1 },
        },
      ]),
    }));

    const result = await adsCampaigns(adsCampaignsInput.parse({}), { credentials, fetchImpl });
    const content = result.structuredContent as { campaigns: Array<{ dailyBudget: number; cost: number }> };

    expect(content.campaigns[0]).toMatchObject({ dailyBudget: 3, cost: 1.25 });
    expect(() => adsCampaignsOutput.parse(content)).not.toThrow();
  });

  it("sorts search terms by cost, because the list is for deciding what to stop paying for", async () => {
    const { fetchImpl } = router(() => ({
      body: stream([
        { searchTermView: { searchTerm: "cheap noise" }, metrics: { impressions: 900, clicks: 0, costMicros: "0", conversions: 0 } },
        { searchTermView: { searchTerm: "costly" }, metrics: { impressions: 3, clicks: 2, costMicros: "4000000", conversions: 0 } },
      ]),
    }));

    const result = await adsSearchTerms(adsSearchTermsInput.parse({ days: 30 }), { credentials, fetchImpl });
    const terms = (result.structuredContent as { searchTerms: Array<{ searchTerm: string }> }).searchTerms;

    // Impressions-first would put 900 impressions of free noise above $4 spent.
    expect(terms.map((t) => t.searchTerm)).toEqual(["costly", "cheap noise"]);
  });

  it("keeps only terms that converted nothing when asked, which is the negatives list", async () => {
    const { fetchImpl } = router(() => ({
      body: stream([
        { searchTermView: { searchTerm: "converted" }, metrics: { impressions: 5, clicks: 1, costMicros: "2000000", conversions: 1 } },
        { searchTermView: { searchTerm: "wasted" }, metrics: { impressions: 5, clicks: 1, costMicros: "2000000", conversions: 0 } },
      ]),
    }));

    const result = await adsSearchTerms(adsSearchTermsInput.parse({ days: 30, zeroConversionsOnly: true }), { credentials, fetchImpl });
    const content = result.structuredContent as { rowCount: number; searchTerms: Array<{ searchTerm: string }>; notes: string[] };

    expect(content.rowCount).toBe(1);
    expect(content.searchTerms[0]?.searchTerm).toBe("wasted");
    expect(content.notes.join(" ")).toMatch(/at least one conversion/);
  });

  it("asks for an explicit date range, since most day counts have no GAQL literal", async () => {
    const { fetchImpl, calls } = router(() => ({ body: stream([]) }));

    await adsKeywords(adsKeywordsInput.parse({ days: 90 }), { credentials, fetchImpl, now: new Date("2026-09-12T00:00:00Z") });

    const query = String(calls[0]?.body?.query);
    expect(query).toContain("segments.date BETWEEN '2026-06-15' AND '2026-09-12'");
    expect(query).not.toContain("LAST_90_DAYS");
  });

  it("says a setting is current, so it cannot be read as the value during the window", async () => {
    // A campaign paused this morning still reports PAUSED beside the
    // impressions it served last month, because Google keeps no setting history.
    const { fetchImpl } = router(() => ({
      body: stream([{ campaign: { name: "zad", status: "PAUSED" }, campaignBudget: { amountMicros: "1000000" }, metrics: { impressions: 1445, clicks: 39, costMicros: "0", conversions: 0 } }]),
    }));

    const result = await adsCampaigns(adsCampaignsInput.parse({ days: 30 }), { credentials, fetchImpl });
    const content = result.structuredContent as { notes: string[] };

    expect(content.notes.join(" ")).toMatch(/status, dailyBudget are the value now, not the value during the window/);
    expect(content.notes.join(" ")).toMatch(/ads_changes/);
    expect(() => adsCampaignsOutput.parse(content)).not.toThrow();
  });

  it("reads search terms and keeps Google's withholding caveat attached", async () => {
    const { fetchImpl } = router(() => ({
      body: stream([
        {
          searchTermView: { searchTerm: "duplicator pro plugin", status: "NONE" },
          segments: { keyword: { info: { text: "duplicator pro" } } },
          campaign: { name: "safeguard" },
          metrics: { impressions: 1, clicks: 0, costMicros: "0", conversions: 0 },
        },
      ]),
    }));

    const result = await adsSearchTerms(adsSearchTermsInput.parse({ days: 90 }), { credentials, fetchImpl });
    const content = result.structuredContent as { searchTerms: Array<{ matchedKeyword: string }>; notes: string[] };

    expect(content.searchTerms[0]).toMatchObject({ searchTerm: "duplicator pro plugin", matchedKeyword: "duplicator pro" });
    // The same shape as Search Console withholding low-volume queries.
    expect(content.notes.join(" ")).toMatch(/absent term is unknown rather than absent/);
    expect(() => adsSearchTermsOutput.parse(content)).not.toThrow();
  });

  it("drops search terms below the impression floor and says how many", async () => {
    const { fetchImpl } = router(() => ({
      body: stream([
        { searchTermView: { searchTerm: "loud" }, metrics: { impressions: 40, clicks: 1, costMicros: "0", conversions: 0 } },
        { searchTermView: { searchTerm: "quiet" }, metrics: { impressions: 1, clicks: 0, costMicros: "0", conversions: 0 } },
      ]),
    }));

    const result = await adsSearchTerms(adsSearchTermsInput.parse({ days: 30, minImpressions: 10 }), { credentials, fetchImpl });
    const content = result.structuredContent as { rowCount: number; notes: string[] };

    expect(content.rowCount).toBe(1);
    expect(content.notes.join(" ")).toMatch(/1 term\(s\) are not listed because of the filters asked for \(fewer than 10 impressions\)/);
  });

  it("asks change history for a datetime range with a limit, as the resource requires", async () => {
    const { fetchImpl, calls } = router(() => ({
      body: stream([
        {
          changeEvent: {
            changeDateTime: "2026-09-12 12:33:46",
            changeResourceType: "AD_GROUP_CRITERION",
            resourceChangeOperation: "UPDATE",
            changedFields: "cpcBidMicros",
            userEmail: "someone@example.com",
            clientType: "GOOGLE_ADS_API",
          },
          campaign: { name: "safeguard" },
        },
      ]),
    }));

    const result = await adsChanges(adsChangesInput.parse({ days: 14, limit: 100 }), { credentials, fetchImpl, now: new Date("2026-09-12T00:00:00Z") });
    const query = String(calls[0]?.body?.query);
    const content = result.structuredContent as { changes: Array<{ clientType: string }>; notes: string[] };

    expect(query).toContain("BETWEEN '2026-08-30 00:00:00' AND '2026-09-12 23:59:59'");
    expect(query).toContain("LIMIT 100");
    // Whether a change came from a tool or from a person in the browser.
    expect(content.changes[0]?.clientType).toBe("GOOGLE_ADS_API");
    expect(content.notes.join(" ")).toMatch(/GOOGLE_ADS_WEB_CLIENT for someone in the browser/);
    expect(() => adsChangesOutput.parse(content)).not.toThrow();
  });

  it("warns when the change list is exactly the limit, because there may be more", async () => {
    const { fetchImpl } = router(() => ({ body: stream([{ changeEvent: { changeDateTime: "x" } }, { changeEvent: { changeDateTime: "y" } }]) }));

    const result = await adsChanges(adsChangesInput.parse({ days: 14, limit: 2 }), { credentials, fetchImpl });

    expect((result.structuredContent as { notes: string[] }).notes.join(" ")).toMatch(/which is the limit asked for, so there may be more/);
  });

  it("refuses a query that is not a SELECT", async () => {
    const { fetchImpl, calls } = router(() => ({ body: stream([]) }));

    await expect(adsQuery(adsQueryInput.parse({ query: "UPDATE campaign SET x = 1" }), { credentials, fetchImpl })).rejects.toThrow(/must start with SELECT/);
    expect(calls).toHaveLength(0);
  });
});

describe("ads_update", () => {
  const keywordRow = {
    adGroupCriterion: { resourceName: "customers/1/adGroupCriteria/2~3", keyword: { text: "wordpress backup" }, effectiveCpcBidMicros: "2000000" },
  };

  it("is a dry run by default, and changes nothing", async () => {
    const { fetchImpl, calls } = router(() => ({ body: stream([keywordRow]) }));

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "wordpress backup", value: "3.00" }), { credentials, fetchImpl });
    const content = result.structuredContent as { applied: boolean; before: string; after: string };

    expect(content).toMatchObject({ applied: false, before: "$2.00", after: "$3.00" });
    expect(result.content[0]?.text).toContain("Dry run");
    expect(calls.some((call) => call.url.includes(":mutate"))).toBe(false);
    expect(() => adsUpdateOutput.parse(content)).not.toThrow();
  });

  it("returns the guard reasons in the dry run, so confirming is not blind", async () => {
    const { fetchImpl } = router(() => ({ body: stream([keywordRow]) }));

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "wordpress backup", value: "30.00" }), { credentials, fetchImpl });
    const guards = (result.structuredContent as { guards: string[] }).guards.join(" ");

    // $2 to $30 is fifteen times, so the wording escalates past "three".
    expect(guards).toMatch(/over ten times the current value/);
    expect(guards).toMatch(/above the \$25 ceiling/);
  });

  it("uses the milder wording in the three to ten times band", async () => {
    const { fetchImpl } = router(() => ({ body: stream([keywordRow]) }));

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "wordpress backup", value: "8.00" }), { credentials, fetchImpl });
    const guards = (result.structuredContent as { guards: string[] }).guards;

    expect(guards.join(" ")).toMatch(/more than three times the current value, \$2.00 to \$8.00/);
    // Four times the bid but still under the ceiling, so only one guard trips.
    expect(guards).toHaveLength(1);
  });

  it("states the monthly equivalent of a daily budget, because a daily number reads small", async () => {
    const { fetchImpl } = router(() => ({
      body: stream([{ campaign: { name: "search-uk" }, campaignBudget: { resourceName: "customers/1/campaignBudgets/9", amountMicros: "3000000" } }]),
    }));

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "budget", target: "search-uk", value: "30.00" }), { credentials, fetchImpl });

    expect((result.structuredContent as { guards: string[] }).guards.join(" ")).toMatch(/about \$912 a month/);
  });

  it("refuses a guarded change without confirm, and writes nothing", async () => {
    const { fetchImpl, calls } = router(() => ({ body: stream([keywordRow]) }));

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "wordpress backup", value: "30.00", dryRun: false }), { credentials, fetchImpl });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { applied: boolean }).applied).toBe(false);
    expect(calls.some((call) => call.url.includes(":mutate"))).toBe(false);
  });

  it("reads the value back after a write and reports that it matches", async () => {
    let written = false;
    const { fetchImpl, calls } = router((url) => {
      if (url.includes(":mutate")) {
        written = true;
        return { body: { results: [{}] } };
      }
      const bid = written ? "3000000" : "2000000";
      return { body: stream([{ adGroupCriterion: { ...keywordRow.adGroupCriterion, effectiveCpcBidMicros: bid } }]) };
    });

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "wordpress backup", value: "3.00", dryRun: false }), { credentials, fetchImpl });
    const content = result.structuredContent as { applied: boolean; readBack: string; matches: boolean };

    expect(content).toMatchObject({ applied: true, readBack: "$3.00", matches: true });
    expect(result.isError).toBeUndefined();
    expect(calls.filter((call) => call.url.includes(":mutate"))).toHaveLength(1);
  });

  it("fails loudly when the stored value is not what was sent", async () => {
    // A 200 from mutate is evidence the request was accepted, not that it
    // stored what was meant. This is the case that distinction exists for.
    const { fetchImpl } = router((url) => {
      if (url.includes(":mutate")) return { body: { results: [{}] } };
      return { body: stream([{ adGroupCriterion: { ...keywordRow.adGroupCriterion, effectiveCpcBidMicros: "2000000" } }]) };
    });

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "wordpress backup", value: "3.00", dryRun: false }), { credentials, fetchImpl });
    const content = result.structuredContent as { applied: boolean; readBack: string; matches: boolean };

    expect(result.isError).toBe(true);
    expect(content).toMatchObject({ applied: true, readBack: "$2.00", matches: false });
    expect(result.content[0]?.text).toContain("DOES NOT match");
  });

  it("refuses a target that matches nothing, and one that matches more than one", async () => {
    const none = router(() => ({ body: stream([]) }));
    await expect(adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "typo", value: "1.00" }), { credentials, fetchImpl: none.fetchImpl })).rejects.toThrow(/No keyword matched/);

    const many = router(() => ({ body: stream([keywordRow, keywordRow]) }));
    await expect(adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "backup", value: "1.00" }), { credentials, fetchImpl: many.fetchImpl })).rejects.toThrow(/2 keywords matched/);
  });

  it("says a change is already in place instead of sending a pointless mutation", async () => {
    const { fetchImpl, calls } = router(() => ({ body: stream([{ campaign: { resourceName: "customers/1/campaigns/5", name: "search-uk", status: "PAUSED" } }]) }));

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "campaignStatus", target: "search-uk", value: "pause", dryRun: false, confirm: true }), { credentials, fetchImpl });

    expect((result.structuredContent as { noOp: boolean }).noOp).toBe(true);
    expect(calls.some((call) => call.url.includes(":mutate"))).toBe(false);
  });

  it("guards pausing something that is currently serving", async () => {
    const { fetchImpl } = router(() => ({ body: stream([{ campaign: { resourceName: "customers/1/campaigns/5", name: "search-uk", status: "ENABLED" } }]) }));

    const result = await adsUpdate(adsUpdateInput.parse({ kind: "campaignStatus", target: "search-uk", value: "pause" }), { credentials, fetchImpl });

    expect((result.structuredContent as { guards: string[] }).guards.join(" ")).toMatch(/currently serving/);
  });

  it("escapes the target into the query rather than stripping it", async () => {
    const { fetchImpl, calls } = router(() => ({ body: stream([keywordRow]) }));

    await adsUpdate(adsUpdateInput.parse({ kind: "bid", target: "o'brien backup", value: "1.00" }), { credentials, fetchImpl });

    expect(String(calls[0]?.body?.query)).toContain("'o\\'brien backup'");
  });
});
