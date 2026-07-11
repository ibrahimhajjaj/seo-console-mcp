import { describe, expect, it, vi } from "vitest";
import { createCloudflareClient } from "../src/cloudflare.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("cloudflare client", () => {
  it("finds the zone id by walking up subdomain labels", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("name=safeguard.verdelic.com")) return jsonResponse({ success: true, errors: [], result: [] });
      if (url.includes("name=verdelic.com")) return jsonResponse({ success: true, errors: [], result: [{ id: "zone1", name: "verdelic.com" }] });
      return jsonResponse({ success: true, errors: [], result: [] });
    });
    const cf = createCloudflareClient("tok", fetchImpl as unknown as typeof fetch);
    const id = await cf.findZoneId("safeguard.verdelic.com");
    expect(id).toBe("zone1");
    expect(calls[0]).toContain("name=safeguard.verdelic.com");
    expect(calls[1]).toContain("name=verdelic.com");
  });

  it("throws a clear error when no zone matches", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, errors: [], result: [] }));
    const cf = createCloudflareClient("tok", fetchImpl as unknown as typeof fetch);
    await expect(cf.findZoneId("example.com")).rejects.toThrow(/No Cloudflare zone found/);
  });

  it("creates a TXT record when none matches and reports created", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/dns_records?")) return jsonResponse({ success: true, errors: [], result: [] });
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ success: true, errors: [], result: { id: "rec1" } });
      }
      return jsonResponse({ success: true, errors: [], result: [] });
    });
    const cf = createCloudflareClient("tok", fetchImpl as unknown as typeof fetch);
    const state = await cf.ensureTxtRecord("zone1", "getpsst.app", "google-site-verification=abc");
    expect(state).toBe("created");
    expect(posted[0]).toMatchObject({ type: "TXT", name: "getpsst.app", content: "google-site-verification=abc" });
  });

  it("skips creation when a matching TXT record already exists", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/dns_records?")) {
        return jsonResponse({ success: true, errors: [], result: [{ id: "rec1", content: "\"google-site-verification=abc\"" }] });
      }
      return jsonResponse({ success: true, errors: [], result: [] });
    });
    const cf = createCloudflareClient("tok", fetchImpl as unknown as typeof fetch);
    const state = await cf.ensureTxtRecord("zone1", "getpsst.app", "google-site-verification=abc");
    expect(state).toBe("exists");
  });

  it("surfaces Cloudflare error envelopes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null }, false, 403));
    const cf = createCloudflareClient("tok", fetchImpl as unknown as typeof fetch);
    await expect(cf.findZoneId("example.com")).rejects.toThrow(/9109 Invalid access token/);
  });
});
