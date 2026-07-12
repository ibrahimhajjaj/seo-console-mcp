import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { indexNowSubmitInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";

type IndexNowParams = z.output<typeof indexNowSubmitInput>;

const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const SUBMIT_TIMEOUT_MS = 15_000;

// Response semantics defined by the IndexNow protocol.
const STATUS_NOTES: Record<number, string> = {
  200: "URLs submitted.",
  202: "URLs received; the endpoint validates the key asynchronously.",
  400: "Bad request: the submission body was rejected.",
  403: "Key not valid: confirm the key file is reachable at its location and contains exactly the submitted key.",
  422: "URLs rejected: they do not belong to the host, or the key does not match them.",
  429: "Too many requests: slow down submissions.",
};

export async function submitIndexNow(
  params: IndexNowParams,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ToolResult> {
  // The env fallback bypasses the schema, so the key format is re-checked here.
  const key = params.key ?? process.env.SEO_MCP_INDEXNOW_KEY;
  if (!key) {
    throw new Error("An IndexNow key is required. Pass key or set SEO_MCP_INDEXNOW_KEY, and host the key at https://<host>/<key>.txt (a text file containing only the key). The key value is never logged.");
  }
  if (!KEY_PATTERN.test(key)) {
    throw new Error("IndexNow keys are 8-128 characters of a-z, A-Z, 0-9, or dash.");
  }
  const hosts = [...new Set(params.urls.map((url) => new URL(url).host))];
  if (hosts.length > 1) {
    throw new Error(`One IndexNow submission covers one host; got ${hosts.join(", ")}. Split the URL list by host.`);
  }
  const host = hosts[0] as string;
  if (params.keyLocation && new URL(params.keyLocation).host !== host) {
    throw new Error(`keyLocation must be hosted on ${host}, the host of the submitted URLs.`);
  }
  // The key file URL conventionally contains the key itself, so neither the key
  // nor keyLocation may appear in any output or error path.
  const shared = {
    endpoint: params.endpoint,
    host,
    urlCount: params.urls.length,
  };
  if (params.dryRun) {
    return result(
      `Dry run: would submit ${params.urls.length} URL(s) for ${host} to ${params.endpoint}. No notification sent.`,
      { success: true, dryRun: true, statusCode: null, note: "Dry run.", ...shared },
    );
  }
  const response = await (deps.fetchImpl ?? fetch)(`https://${params.endpoint}/indexnow`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      host,
      key,
      ...(params.keyLocation ? { keyLocation: params.keyLocation } : {}),
      urlList: params.urls,
    }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  const success = response.status === 200 || response.status === 202;
  const note = STATUS_NOTES[response.status] ?? `Unexpected response: HTTP ${response.status} ${response.statusText}.`;
  const text = [
    `IndexNow ${success ? "accepted" : "rejected"} ${params.urls.length} URL(s) for ${host} (HTTP ${response.status} from ${params.endpoint}). ${note}`,
    "Participating engines (Bing, Yandex, Naver, Seznam, Yep) share IndexNow submissions with each other. Google does not use IndexNow; use request_recrawl for Google.",
  ].join("\n");
  return result(text, { success, statusCode: response.status, note, ...shared });
}

function result(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}
