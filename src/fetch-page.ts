import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { USER_AGENT } from "./version.js";

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// Non-public ranges a model-driven fetch must not reach: loopback, RFC1918,
// CGNAT, link-local (incl. cloud metadata), ULA, unspecified, broadcast.
const nonPublic = new BlockList();
nonPublic.addSubnet("0.0.0.0", 8);
nonPublic.addSubnet("10.0.0.0", 8);
nonPublic.addSubnet("100.64.0.0", 10);
nonPublic.addSubnet("127.0.0.0", 8);
nonPublic.addSubnet("169.254.0.0", 16);
nonPublic.addSubnet("172.16.0.0", 12);
nonPublic.addSubnet("192.168.0.0", 16);
nonPublic.addAddress("255.255.255.255");
nonPublic.addAddress("::1", "ipv6");
nonPublic.addAddress("::", "ipv6");
nonPublic.addSubnet("fc00::", 7, "ipv6");
nonPublic.addSubnet("fe80::", 10, "ipv6");

type LookupHost = NonNullable<FetchHtmlOptions["lookupHost"]>;

function normalizeAddress(address: string): string {
  const host = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  return mapped?.[1] ?? host;
}

function isNonPublicAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (family === 4) return nonPublic.check(normalized, "ipv4");
  if (family === 6) return nonPublic.check(normalized, "ipv6");
  return false;
}

async function assertPublicHost(hostname: string, lookupHost: LookupHost): Promise<void> {
  const host = normalizeAddress(hostname);
  const addresses = isIP(host) === 0 ? await lookupHost(host) : [{ address: host, family: isIP(host) }];
  if (addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new Error(`Refusing to fetch ${host}: resolves to a non-public address. Set SEO_MCP_ALLOW_PRIVATE_HOSTS=1 to audit internal hosts.`);
  }
}

export interface FetchHtmlOptions {
  fetchImpl?: typeof fetch;
  lookupHost?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  allowPrivateHosts?: boolean;
}

export async function fetchHtml(
  url: string,
  options: FetchHtmlOptions = {},
): Promise<{ html: string; finalUrl: string; status: number }> {
  const {
    fetchImpl = fetch,
    lookupHost = (hostname: string) => lookup(hostname, { all: true }),
    allowPrivateHosts = process.env.SEO_MCP_ALLOW_PRIVATE_HOSTS === "1",
  } = options;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let currentUrl = new URL(url);
  let redirects = 0;
  let response: Response;

  while (true) {
    if (!allowPrivateHosts) await assertPublicHost(currentUrl.hostname, lookupHost);
    response = await fetchImpl(currentUrl.toString(), {
      redirect: "manual",
      signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (location === null) break;
    if (redirects >= MAX_REDIRECTS) throw new Error("Too many redirects (>5)");
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new Error(`Refusing to follow redirect to ${nextUrl.protocol} URL`);
    }
    currentUrl = nextUrl;
    redirects += 1;
  }

  if (!response.ok) throw new Error(`Page fetch failed with HTTP ${response.status} ${response.statusText}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_HTML_BYTES) throw new Error("Page HTML exceeds the 10 MB audit limit");
  const bytes = await readCappedBody(response);
  const charset = detectCharset(response.headers.get("content-type"), bytes);
  return { html: decodeBytes(bytes, charset), finalUrl: currentUrl.toString(), status: response.status };
}

// Read the body incrementally so a missing/false content-length cannot force an
// unbounded allocation: stop and cancel the stream the moment the running total
// crosses the cap, before the whole body is in memory.
async function readCappedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error("Page HTML exceeds the 10 MB audit limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Honor the response charset (Content-Type, else a <meta charset> in the head)
// so non-UTF-8 pages are not mangled into replacement characters.
function detectCharset(contentType: string | null, bytes: Uint8Array): string {
  const headerCharset = contentType ? /charset=["']?([\w-]+)/i.exec(contentType)?.[1] : undefined;
  if (headerCharset) return headerCharset;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const metaCharset = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)?.[1]
    ?? /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  return metaCharset ?? "utf-8";
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
