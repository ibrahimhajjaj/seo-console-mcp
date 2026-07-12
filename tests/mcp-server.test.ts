import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { fetchHtml } from "../src/fetch-page.js";
import type { GoogleClients } from "../src/google-tools.js";
import { registerTools, type ToolDependencies } from "../src/tools.js";

vi.mock("../src/fetch-page.js", () => ({ fetchHtml: vi.fn() }));

async function connectedClient(dependencies: ToolDependencies = {}): Promise<Client> {
  const server = new McpServer({ name: "seo-mcp-test", version: "0.0.0" });
  registerTools(server, dependencies);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function fakeClients(): GoogleClients {
  return {
    searchConsole: {
      searchanalytics: { query: vi.fn() },
      sitemaps: { list: vi.fn(), submit: vi.fn() },
      urlInspection: { index: { inspect: vi.fn() } },
    },
    pageSpeed: { pagespeedapi: { runpagespeed: vi.fn() } },
  };
}

describe("MCP server tool registration", () => {
  it("lists all registered tools with descriptions", async () => {
    const client = await connectedClient({ clients: fakeClients() });

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "search_analytics",
      "list_sitemaps",
      "submit_sitemap",
      "inspect_url",
      "pagespeed",
      "seo_audit",
    ]);
    expect(tools.every((tool) => tool.description?.length)).toBe(true);
    expect(tools.every((tool) => tool.outputSchema)).toBe(true);
  });

  it("validates search analytics structured output", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: {
      metadata: { firstIncompleteDate: "2026-07-10" },
      rows: [{ keys: ["seo mcp"], clicks: 12, impressions: 100, ctr: 0.12, position: 3.456 }],
    } });
    const client = await connectedClient({ clients });

    const result = await client.callTool({
      name: "search_analytics",
      arguments: { siteUrl: "https://example.com/", startDate: "2026-07-01", endDate: "2026-07-11" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      firstIncompleteDate: "2026-07-10",
      rowCount: 1,
      rows: [{ rank: 1, keys: { query: "seo mcp" } }],
    });
  });

  it("validates sitemap list structured output", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sitemaps.list).mockResolvedValue({ data: { sitemap: [{
      path: "https://example.com/sitemap.xml",
      lastSubmitted: "2026-07-01T00:00:00Z",
      isPending: false,
      warnings: "1",
      errors: "0",
      contents: [{ type: "web", submitted: "42", indexed: "40" }],
    }] } });
    const client = await connectedClient({ clients });

    const result = await client.callTool({
      name: "list_sitemaps",
      arguments: { siteUrl: "https://example.com/" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      count: 1,
      sitemaps: [{ path: "https://example.com/sitemap.xml", lastDownloaded: null }],
    });
  });

  it("validates sitemap submission output when state refresh fails", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.sitemaps.submit).mockResolvedValue({ data: undefined });
    vi.mocked(clients.searchConsole.sitemaps.list).mockRejectedValue(new Error("temporary list failure"));
    const client = await connectedClient({ clients });

    const result = await client.callTool({
      name: "submit_sitemap",
      arguments: { siteUrl: "https://example.com/", feedpath: "https://example.com/sitemap.xml" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: true,
      sitemap: null,
      stateRefreshError: "temporary list failure",
    });
  });

  it("validates URL inspection output with nullable index fields", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.urlInspection.index.inspect).mockResolvedValue({ data: {
      inspectionResult: { indexStatusResult: { verdict: "PASS" } },
    } });
    const client = await connectedClient({ clients });

    const result = await client.callTool({
      name: "inspect_url",
      arguments: { siteUrl: "sc-domain:example.com", inspectionUrl: "https://example.com/page" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      indexStatus: {
        verdict: "PASS",
        coverageState: null,
        robotsTxtState: null,
        indexingState: null,
        lastCrawlTime: null,
        googleCanonical: null,
        userCanonical: null,
        pageFetchState: null,
      },
      mobileUsability: null,
      richResults: null,
    });
  });

  it("validates PageSpeed output with a nullable category score", async () => {
    const clients = fakeClients();
    vi.mocked(clients.pageSpeed.pagespeedapi.runpagespeed).mockResolvedValue({ data: {
      loadingExperience: { metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2400, category: "AVERAGE" },
      } },
      lighthouseResult: {
        categories: { performance: { score: null } },
        audits: { unused: { title: "Unused JavaScript", score: 0, details: { overallSavingsMs: 250 } } },
      },
    } });
    const client = await connectedClient({ clients });

    const result = await client.callTool({
      name: "pagespeed",
      arguments: { url: "https://example.com/" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      fieldData: { lcp: { value: 2400, category: "AVERAGE" } },
      scores: { performance: null },
      opportunities: [{ id: "unused", description: null, savingsMs: 250 }],
    });
  });

  it("validates SEO audit structured output", async () => {
    vi.mocked(fetchHtml).mockResolvedValue({
      html: "<html lang='en'><head><title>Example</title></head><body><h1>Heading</h1></body></html>",
      finalUrl: "https://example.com/",
      status: 200,
    });
    const client = await connectedClient({ clients: fakeClients() });

    const result = await client.callTool({
      name: "seo_audit",
      arguments: { url: "https://example.com/" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      url: "https://example.com/",
      title: { text: "Example", count: 1, length: 7 },
      canonical: null,
      httpStatus: 200,
    });
  });

  it("applies input transforms and defaults before invoking the handler", async () => {
    const clients = fakeClients();
    vi.mocked(clients.searchConsole.searchanalytics.query).mockResolvedValue({ data: { rows: [] } });
    const client = await connectedClient({ clients });

    await client.callTool({
      name: "search_analytics",
      arguments: { siteUrl: "https://Example.com/path" },
    });

    expect(clients.searchConsole.searchanalytics.query).toHaveBeenCalledWith({
      siteUrl: "https://example.com/path/",
      requestBody: expect.objectContaining({
        dimensions: ["query"],
        rowLimit: 25,
      }),
    });
  });

  it("returns handler failures as error results and keeps the connection usable", async () => {
    const clients = fakeClients();
    const query = vi.mocked(clients.searchConsole.searchanalytics.query);
    query.mockRejectedValueOnce(new Error("boom"));
    query.mockResolvedValueOnce({ data: { rows: [] } });
    const client = await connectedClient({ clients });

    const failed = await client.callTool({
      name: "search_analytics",
      arguments: { siteUrl: "https://example.com/" },
    });

    expect(failed.isError).toBe(true);
    expect(failed.content[0]).toMatchObject({ type: "text", text: "boom" });

    const succeeded = await client.callTool({
      name: "search_analytics",
      arguments: { siteUrl: "https://example.com/" },
    });
    expect(succeeded.isError).not.toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns an error result when Search Console credentials are missing", async () => {
    const client = await connectedClient({});

    const result = await client.callTool({
      name: "search_analytics",
      arguments: { siteUrl: "https://example.com/" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("credentials are not configured"),
    });
  });

  it("allows PageSpeed calls with injected clients and no credentials", async () => {
    const clients = fakeClients();
    vi.mocked(clients.pageSpeed.pagespeedapi.runpagespeed).mockResolvedValue({ data: {} });
    const client = await connectedClient({ clients });

    const result = await client.callTool({
      name: "pagespeed",
      arguments: { url: "https://example.com/" },
    });

    expect(result.isError).not.toBe(true);
  });

  it("rejects invalid arguments before invoking the handler", async () => {
    const clients = fakeClients();
    const client = await connectedClient({ clients });

    // The SDK resolves callTool with an error result when input validation fails.
    const result = await client.callTool({
      name: "search_analytics",
      arguments: { siteUrl: "example.com" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/siteUrl|invalid/i),
    });
    expect(clients.searchConsole.searchanalytics.query).not.toHaveBeenCalled();
  });
});
