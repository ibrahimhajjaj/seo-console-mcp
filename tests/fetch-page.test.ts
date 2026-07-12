import { describe, expect, it, vi } from "vitest";
import { fetchHtml } from "../src/fetch-page.js";

describe("fetchHtml", () => {
  it("returns decoded HTML, final URL, and status", async () => {
    const fetchImpl = vi.fn(async () => new Response("<title>Example</title>", {
      status: 200,
      headers: { "content-length": "22" },
    }));

    const result = await fetchHtml("https://example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result).toEqual({
      html: "<title>Example</title>",
      finalUrl: "https://example.com/",
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws for a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("Missing", {
      status: 404,
      statusText: "Not Found",
    }));

    await expect(fetchHtml("https://example.com/missing", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    })).rejects.toThrow("Page fetch failed with HTTP 404 Not Found");
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const fetchImpl = vi.fn();

    await expect(fetchHtml("https://internal.example/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: async () => [{ address: "192.168.1.7", family: 4 }],
    })).rejects.toThrow("Refusing to fetch internal.example: resolves to a non-public address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a link-local IP literal without a DNS lookup", async () => {
    const fetchImpl = vi.fn();
    const lookupHost = vi.fn();

    await expect(fetchHtml("http://169.254.169.254/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost,
    })).rejects.toThrow("Refusing to fetch 169.254.169.254: resolves to a non-public address");
    expect(lookupHost).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an IPv4-mapped loopback IPv6 literal", async () => {
    const fetchImpl = vi.fn();

    await expect(fetchHtml("http://[::ffff:127.0.0.1]/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: vi.fn(),
    })).rejects.toThrow(/resolves to a non-public address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows public redirects and checks every hop", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://first.example/") {
        return new Response(null, { status: 301, headers: { location: "https://second.example/page" } });
      }
      return new Response("<title>Second</title>", { status: 200 });
    });
    const lookupHost = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

    const result = await fetchHtml("https://first.example/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost,
    });

    expect(result.finalUrl).toBe("https://second.example/page");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(lookupHost.mock.calls).toEqual([["first.example"], ["second.example"]]);
  });

  it("refuses a redirect target that resolves to a private address", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://private.example/secret" },
    }));
    const lookupHost = vi.fn(async (hostname: string) => [{
      address: hostname === "private.example" ? "10.0.0.4" : "93.184.216.34",
      family: 4,
    }]);

    await expect(fetchHtml("https://public.example/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost,
    })).rejects.toThrow("Refusing to fetch private.example: resolves to a non-public address");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects more than five redirects", async () => {
    let redirect = 0;
    const fetchImpl = vi.fn(async () => {
      redirect += 1;
      return new Response(null, { status: 302, headers: { location: `/hop-${redirect}` } });
    });

    await expect(fetchHtml("https://example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    })).rejects.toThrow("Too many redirects (>5)");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("allows private targets when explicitly enabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("internal", { status: 200 }));
    const lookupHost = vi.fn();

    const result = await fetchHtml("http://127.0.0.1/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost,
      allowPrivateHosts: true,
    });

    expect(result.html).toBe("internal");
    expect(lookupHost).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
