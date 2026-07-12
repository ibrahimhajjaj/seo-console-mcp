import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { GoogleClients } from "../src/google-tools.js";
import { registerTools, type ToolDependencies } from "../src/tools.js";

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
