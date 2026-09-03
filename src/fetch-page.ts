import { lookup as dnsLookupCallback } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { gunzipSync } from "node:zlib";
import { Agent } from "undici";
import { USER_AGENT } from "./version.js";

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// Non-public ranges a model-driven fetch must not reach: loopback, RFC1918,
// CGNAT, link-local (incl. cloud metadata), ULA, unspecified, broadcast,
// IETF protocol assignments, benchmarking, multicast, and reserved space.
const nonPublic = new BlockList();
nonPublic.addSubnet("0.0.0.0", 8);
nonPublic.addSubnet("10.0.0.0", 8);
nonPublic.addSubnet("100.64.0.0", 10);
nonPublic.addSubnet("127.0.0.0", 8);
nonPublic.addSubnet("169.254.0.0", 16);
nonPublic.addSubnet("172.16.0.0", 12);
nonPublic.addSubnet("192.168.0.0", 16);
nonPublic.addSubnet("192.0.0.0", 24);
nonPublic.addSubnet("198.18.0.0", 15);
nonPublic.addSubnet("224.0.0.0", 4);
nonPublic.addSubnet("240.0.0.0", 4);
nonPublic.addAddress("255.255.255.255");
nonPublic.addAddress("::1", "ipv6");
nonPublic.addAddress("::", "ipv6");
nonPublic.addSubnet("fc00::", 7, "ipv6");
nonPublic.addSubnet("fe80::", 10, "ipv6");
nonPublic.addSubnet("ff00::", 8, "ipv6");

type LookupHost = NonNullable<FetchHtmlOptions["lookupHost"]>;

// Several IPv6 forms carry an IPv4 address inside them. A block list keyed on
// the outer prefix would let 64:ff9b::10.0.0.5 through as "a public v6 range";
// what matters is the v4 address it delivers to.
function embeddedIpv4(host: string): string | null {
  const normalized = host.toLowerCase();

  // 6to4 holds the address in the two groups right after its prefix; the
  // v4-mapped, NAT64 and deprecated v4-compatible forms hold it in the low 32
  // bits, written either as two hex groups or dotted.
  const [, first, second] = /^2002:([\da-f]{1,4}):([\da-f]{1,4})(?::|$)/.exec(normalized)
    ?? /^(?:::ffff:|64:ff9b::|::)([\da-f]{1,4}):([\da-f]{1,4})$/.exec(normalized)
    ?? [];
  if (first !== undefined && second !== undefined) {
    const high = parseInt(first, 16);
    const low = parseInt(second, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }

  const dotted = /^(?:::ffff:|64:ff9b::|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized)?.[1];
  return dotted !== undefined && isIP(dotted) === 4 ? dotted : null;
}

function normalizeAddress(address: string): string {
  return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

function isNonPublicAddress(address: string): boolean {
  const host = normalizeAddress(address);
  const family = isIP(host);
  if (family === 4) return nonPublic.check(host, "ipv4");
  if (family !== 6) return false;
  if (nonPublic.check(host, "ipv6")) return true;
  const inner = embeddedIpv4(host);
  return inner !== null && nonPublic.check(inner, "ipv4");
}

export type DnsResolver = (
  hostname: string,
  options: { all: true },
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: Array<{ address: string; family: number }>,
  ) => void,
) => void;

// Every resolved address must be validated and passed unchanged to the socket.
export function createPublicOnlyLookup(resolve: DnsResolver) {
  return (
    hostname: string,
    options: unknown,
    callback: (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    resolve(hostname, { ...(options as object), all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const bad = addresses.find((address) => isNonPublicAddress(address.address));
      if (bad) {
        return callback(
          new Error(`Refusing to connect to ${hostname}: resolves to a non-public address (${bad.address}).`),
          "",
          0,
        );
      }
      callback(null, addresses);
    });
  };
}

let publicOnlyAgent: Agent | undefined;

// The process-wide agent is cached so every fetch shares one connection pool.
// A caller-supplied resolver gets its own uncached agent instead: that is the
// only way to hand the socket a different answer than the pre-check saw, which
// is exactly the shape of a DNS rebinding attack, so it is what the integration
// test needs to prove the dispatcher is honored at all.
function publicOnlyDispatcher(resolver?: DnsResolver): Agent {
  if (resolver) return new Agent({ connect: { lookup: createPublicOnlyLookup(resolver) } });
  publicOnlyAgent ??= new Agent({
    connect: { lookup: createPublicOnlyLookup(dnsLookupCallback as unknown as DnsResolver) },
  });
  return publicOnlyAgent;
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
  connectResolver?: DnsResolver;
}

export async function fetchHtml(
  url: string,
  options: FetchHtmlOptions = {},
): Promise<{ html: string; finalUrl: string; status: number }> {
  const {
    fetchImpl = fetch,
    lookupHost = (hostname: string) => lookup(hostname, { all: true }),
    allowPrivateHosts = process.env.SEO_MCP_ALLOW_PRIVATE_HOSTS === "1",
    connectResolver,
  } = options;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let currentUrl = new URL(url);
  let redirects = 0;
  let response: Response;

  while (true) {
    if (!allowPrivateHosts) await assertPublicHost(currentUrl.hostname, lookupHost);
    // dispatcher pins the connection to the validated address (closes the DNS
    // rebinding race the hostname-only pre-check above cannot). undici extension
    // to RequestInit, so the init is typed to allow it.
    const init: RequestInit & { dispatcher?: Agent } = {
      redirect: "manual",
      signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      },
      ...(allowPrivateHosts ? {} : { dispatcher: publicOnlyDispatcher(connectResolver) }),
    };
    response = await fetchImpl(currentUrl.toString(), init);

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
  const bytes = gunzipIfNeeded(await readCappedBody(response));
  const charset = detectCharset(response.headers.get("content-type"), bytes);
  return { html: decodeBytes(bytes, charset), finalUrl: currentUrl.toString(), status: response.status };
}

// A `.xml.gz` sitemap is served with whatever content type the host feels like
// (application/gzip, application/octet-stream, text/xml), so the label cannot
// decide this; the two-byte gzip magic number can. A body compressed with
// Content-Encoding is already inflated by fetch before it reaches here, so
// anything still gzipped at this point is a gzip file, not a transfer encoding.
function gunzipIfNeeded(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  try {
    // Cap the inflated size too, otherwise a small gzip bomb walks straight
    // past the 10 MB budget the compressed body was checked against.
    return new Uint8Array(gunzipSync(bytes, { maxOutputLength: MAX_HTML_BYTES }));
  } catch (error) {
    if (error instanceof RangeError) throw new Error("Page body exceeds the 10 MB audit limit after decompression");
    throw new Error("Page body looks gzipped but could not be decompressed");
  }
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
