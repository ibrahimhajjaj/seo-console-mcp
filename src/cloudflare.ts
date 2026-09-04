const CF_API = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 20_000;

export interface CloudflareClient {
  findZoneId(domain: string): Promise<string>;
  ensureTxtRecord(zoneId: string, name: string, content: string): Promise<"created" | "exists">;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

type FetchLike = typeof fetch;

export function createCloudflareClient(token: string, fetchImpl: FetchLike = fetch): CloudflareClient {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${CF_API}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      // An aborted fetch reports only "This operation was aborted", which reads
      // as a bug in the caller rather than an unanswered request.
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error("The Cloudflare API did not answer within 20s.");
      }
      throw new Error(`Could not reach the Cloudflare API: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null;
    if (!response.ok || !body?.success) {
      const detail = body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${response.status}`;
      throw new Error(`Cloudflare API error: ${detail}`);
    }
    return body.result;
  }

  return {
    async findZoneId(domain) {
      // Walk up the labels so a subdomain resolves to its parent zone (sub.example.com -> example.com).
      const labels = domain.split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        const candidate = labels.slice(i).join(".");
        const zones = await call<Array<{ id: string; name: string }>>(`/zones?name=${encodeURIComponent(candidate)}`);
        if (zones.length > 0) return zones[0]!.id;
      }
      throw new Error(`No Cloudflare zone found for ${domain}. Confirm the domain is in this Cloudflare account and the token can read its zones.`);
    },

    async ensureTxtRecord(zoneId, name, content) {
      const existing = await call<Array<{ id: string; content: string }>>(`/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`);
      // Cloudflare may return TXT content wrapped in quotes; strip before comparing.
      const alreadyPresent = existing.some((record) => record.content.replace(/^"|"$/g, "") === content);
      if (alreadyPresent) return "exists";
      await call(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: "TXT", name, content, ttl: 120, comment: "seo-mcp Search Console verification" }),
      });
      return "created";
    },
  };
}
