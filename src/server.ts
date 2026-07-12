import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

export async function startServer(credentialsPath?: string): Promise<void> {
  const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION });
  registerTools(server, { ...(credentialsPath ? { credentialsPath } : {}) });
  await server.connect(new StdioServerTransport());
  console.error("seo-mcp: MCP server ready");
}
