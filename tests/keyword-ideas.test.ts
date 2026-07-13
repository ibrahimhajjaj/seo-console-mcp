import { describe, expect, it, vi } from "vitest";
import { keywordIdeas } from "../src/keyword-ideas.js";
import { keywordIdeasInput } from "../src/schemas.js";

function params(overrides: Record<string, unknown> = {}) {
  return keywordIdeasInput.parse({ seed: "SEO", expansions: [], ...overrides });
}

function autocomplete(responses: Record<string, string[]>, failures: string[] = []) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("q") ?? "";
    if (failures.includes(query)) throw new Error("request failed");
    return new Response(JSON.stringify([query, responses[query] ?? []]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("keywordIdeas", () => {
  it("discovers suggestions from the bare seed", async () => {
    const fetchImpl = autocomplete({ SEO: ["SEO tools", "  seo   audit  ", "SEO", ""] });

    const output = await keywordIdeas(params({ language: "fr", country: "ca" }), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("client=firefox&q=SEO&hl=fr&gl=ca");
    expect(init).toMatchObject({ headers: { "user-agent": expect.stringContaining("seo-console-mcp/") } });
    expect(output.structuredContent).toMatchObject({
      seed: "SEO",
      totalFound: 2,
      returned: 2,
      requestFailures: 0,
      gscMatched: 0,
      crossReferenced: false,
      ideas: [
        { keyword: "seo tools", family: "seed", gsc: null },
        { keyword: "seo audit", family: "seed", gsc: null },
      ],
    });
  });

  it("runs enabled expansion families and labels their suggestions", async () => {
    const fetchImpl = autocomplete({
      "SEO a": ["seo agency"],
      "how SEO": ["how seo works"],
      "SEO for": ["seo for dentists"],
      "best SEO": ["best seo software"],
    });

    const output = await keywordIdeas(params({
      expansions: ["alphabet", "questions", "prepositions", "comparisons"],
    }), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(47);
    expect(output.structuredContent.ideas).toEqual([
      { keyword: "seo agency", family: "alphabet", gsc: null },
      { keyword: "how seo works", family: "questions", gsc: null },
      { keyword: "seo for dentists", family: "prepositions", gsc: null },
      { keyword: "best seo software", family: "comparisons", gsc: null },
    ]);
  });

  it("deduplicates suggestions across families with the first family winning", async () => {
    const fetchImpl = autocomplete({
      "SEO vs": ["SEO vs SEM"],
      "best SEO": [" seo   vs sem ", "Best SEO Tool"],
    });

    const output = await keywordIdeas(params({ expansions: ["prepositions", "comparisons"] }), { fetchImpl });

    expect(output.structuredContent.ideas).toEqual([
      { keyword: "seo vs sem", family: "prepositions", gsc: null },
      { keyword: "best seo tool", family: "comparisons", gsc: null },
    ]);
  });

  it("counts partial request failures without failing the tool", async () => {
    const fetchImpl = autocomplete({ SEO: ["seo guide"], "SEO b": ["seo basics"] }, ["SEO a"]);

    const output = await keywordIdeas(params({ expansions: ["alphabet"] }), { fetchImpl });

    expect(output.structuredContent).toMatchObject({ requestFailures: 1, totalFound: 2 });
  });

  it("counts a non-200 autocomplete response as a failure", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const query = new URL(String(input)).searchParams.get("q") ?? "";
      const status = query === "SEO a" ? 201 : 200;
      return new Response(JSON.stringify([query, [`${query} idea`]]), { status });
    });

    const output = await keywordIdeas(params({ expansions: ["alphabet"] }), { fetchImpl });

    expect(output.structuredContent).toMatchObject({ requestFailures: 1, totalFound: 26 });
  });

  it("throws when every autocomplete request fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(keywordIdeas(params(), { fetchImpl })).rejects.toThrow(/every Google Autocomplete request failed/i);
  });

  it("cross-references normalized GSC queries and sorts rankings by position first", async () => {
    const fetchImpl = autocomplete({ SEO: ["new idea", " SEO   Audit ", "seo tools", "another idea"] });
    const fetchGscRows = vi.fn().mockResolvedValue([
      { keys: ["seo TOOLS"], position: 8.5, clicks: 12, impressions: 300 },
      { keys: ["  seo audit  "], position: 3.2, clicks: 5, impressions: 100 },
    ]);

    const output = await keywordIdeas(params({ siteUrl: "https://example.com/", days: 30 }), {
      fetchImpl,
      fetchGscRows,
      now: new Date("2026-07-13T12:00:00Z"),
    });

    expect(fetchGscRows).toHaveBeenCalledWith({
      siteUrl: "https://example.com/",
      requestBody: {
        startDate: "2026-06-14",
        endDate: "2026-07-13",
        dimensions: ["query"],
        rowLimit: 5000,
      },
    });
    expect(output.structuredContent).toMatchObject({ crossReferenced: true, gscMatched: 2 });
    expect(output.structuredContent.ideas).toEqual([
      { keyword: "seo audit", family: "seed", gsc: { position: 3.2, clicks: 5, impressions: 100 } },
      { keyword: "seo tools", family: "seed", gsc: { position: 8.5, clicks: 12, impressions: 300 } },
      { keyword: "new idea", family: "seed", gsc: null },
      { keyword: "another idea", family: "seed", gsc: null },
    ]);
  });

  it("applies the limit after sorting while preserving totalFound", async () => {
    const fetchImpl = autocomplete({ SEO: ["one", "two", "three"] });

    const output = await keywordIdeas(params({ limit: 2 }), { fetchImpl });

    expect(output.structuredContent).toMatchObject({ totalFound: 3, returned: 2 });
    expect(output.structuredContent.ideas).toHaveLength(2);
  });

  it("promotes a late-discovered ranking idea past the limit window", async () => {
    const fetchImpl = autocomplete({ SEO: ["net one", "net two", "net three", "ranked late"] });
    const fetchGscRows = vi.fn().mockResolvedValue([
      { keys: ["ranked late"], position: 4, clicks: 9, impressions: 210 },
    ]);

    const output = await keywordIdeas(params({ siteUrl: "https://example.com/", limit: 2 }), {
      fetchImpl,
      fetchGscRows,
      now: new Date("2026-07-13T12:00:00Z"),
    });

    expect(output.structuredContent.ideas).toEqual([
      { keyword: "ranked late", family: "seed", gsc: { position: 4, clicks: 9, impressions: 210 } },
      { keyword: "net one", family: "seed", gsc: null },
    ]);
  });

  it("does not touch the GSC row source when siteUrl is absent", async () => {
    const fetchImpl = autocomplete({ SEO: ["seo guide"] });
    const fetchGscRows = vi.fn();

    await keywordIdeas(params(), { fetchImpl, fetchGscRows });

    expect(fetchGscRows).not.toHaveBeenCalled();
  });
});
