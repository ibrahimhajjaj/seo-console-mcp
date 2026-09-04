import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { listProperties, type GoogleClients, type ToolResult } from "./google-tools.js";
import { createToolContext, toolDefinitions } from "./registry.js";
import { formatToolError } from "./errors.js";
import { registerPrompts } from "./prompts.js";

export interface ToolDependencies {
  credentialsPath?: string;
  clients?: GoogleClients;
  keywordIdeasFetchImpl?: typeof fetch;
}

export function registerTools(server: McpServer, dependencies: ToolDependencies = {}): void {
  const context = createToolContext(dependencies);

  server.registerResource(
    "properties",
    "seo://properties",
    {
      title: "Search Console properties",
      description: "Live list of Google Search Console properties available to the service account",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const properties = await listProperties(context.getAuthenticatedClients());
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(properties.structuredContent) }] };
      } catch (error) {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: formatToolError(error) }) }] };
      }
    },
  );

  for (const definition of toolDefinitions) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputShape,
        outputSchema: definition.outputSchema,
      },
      async (params) => safely(() => definition.run(context, params)),
    );
  }

  registerPrompts(server);
}

async function safely(operation: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return { content: [{ type: "text", text: formatToolError(error) }], isError: true };
  }
}
