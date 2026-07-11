const MAX_HTML_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string; status: number }> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "user-agent": "seo-mcp/0.1 (+https://www.npmjs.com/package/seo-mcp)",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    },
  });
  if (!response.ok) throw new Error(`Page fetch failed with HTTP ${response.status} ${response.statusText}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_HTML_BYTES) throw new Error("Page HTML exceeds the 10 MB audit limit");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_HTML_BYTES) throw new Error("Page HTML exceeds the 10 MB audit limit");
  return { html: new TextDecoder().decode(bytes), finalUrl: response.url || url, status: response.status };
}
