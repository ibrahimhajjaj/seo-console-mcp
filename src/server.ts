import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

export async function startServer(credentialsPath?: string): Promise<void> {
  const server = new McpServer({ name: "seo-mcp", version: "0.1.0" });
  registerTools(server, { ...(credentialsPath ? { credentialsPath } : {}) });
  await server.connect(new StdioServerTransport());
  console.error("seo-mcp: MCP server ready");
}
