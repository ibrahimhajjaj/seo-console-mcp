import { isIP } from "node:net";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createPublicOnlyLookup, fetchHtml } from "../src/fetch-page.js";

function runLookup(addresses: Array<{ address: string; family: number }>): Promise<{ err: Error | null; result: unknown }> {
  const lookup = createPublicOnlyLookup((_hostname, _options, callback) => callback(null, addresses));
  return new Promise((resolve) => lookup("host.example", {}, (err, result) => resolve({ err, result })));
}

describe("createPublicOnlyLookup", () => {
  it("returns an array containing only public addresses", async () => {
    const addresses = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];

    await expect(runLookup(addresses)).resolves.toEqual({ err: null, result: addresses });
  });

  it("rejects a private address", async () => {
    const { err } = await runLookup([{ address: "10.0.0.5", family: 4 }]);

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("non-public address");
  });

  it("rejects a mix of public and private addresses", async () => {
    const { err } = await runLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("non-public address");
  });

  it.each([
    "192.0.0.8",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "ff02::1",
    "::ffff:10.0.0.5",
    "::ffff:a00:5",
    // NAT64, 6to4 and the v4-compatible form all wrap 10.0.0.5.
    "64:ff9b::10.0.0.5",
    "64:ff9b::a00:5",
    "::10.0.0.5",
    "2002:a00:5::",
  ])("rejects %s", async (address) => {
    const { err } = await runLookup([{ address, family: isIP(address) }]);

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("non-public address");
  });

  it.each([
    "93.184.216.34",
    // The same transition prefixes wrapping the public 93.184.216.34.
    "64:ff9b::5db8:d822",
    "2002:5db8:d822::",
    "2606:2800:220:1:248:1893:25c8:1946",
  ])("allows %s", async (address) => {
    const addresses = [{ address, family: isIP(address) }];

    await expect(runLookup(addresses)).resolves.toEqual({ err: null, result: addresses });
  });
});

describe("fetchHtml", () => {
  it("returns decoded HTML, final URL, and status", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<title>Example</title>", {
          status: 200,
          headers: { "content-length": "22" },
        }),
    );

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
    const fetchImpl = vi.fn(
      async () =>
        new Response("Missing", {
          status: 404,
          statusText: "Not Found",
        }),
    );

    await expect(
      fetchHtml("https://example.com/missing", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toThrow("Page fetch failed with HTTP 404 Not Found");
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchHtml("https://internal.example/", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost: async () => [{ address: "192.168.1.7", family: 4 }],
      }),
    ).rejects.toThrow("Refusing to fetch internal.example: resolves to a non-public address");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a hostname that resolves to a NAT64 address wrapping a private one", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchHtml("http://host.example/", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost: async () => [{ address: "64:ff9b::10.0.0.5", family: 6 }],
      }),
    ).rejects.toThrow(/non-public address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a link-local IP literal without a DNS lookup", async () => {
    const fetchImpl = vi.fn();
    const lookupHost = vi.fn();

    await expect(
      fetchHtml("http://169.254.169.254/", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost,
      }),
    ).rejects.toThrow("Refusing to fetch 169.254.169.254: resolves to a non-public address");
    expect(lookupHost).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an IPv4-mapped loopback IPv6 literal", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchHtml("http://[::ffff:127.0.0.1]/", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost: vi.fn(),
      }),
    ).rejects.toThrow(/resolves to a non-public address/);
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
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://private.example/secret" },
        }),
    );
    const lookupHost = vi.fn(async (hostname: string) => [
      {
        address: hostname === "private.example" ? "10.0.0.4" : "93.184.216.34",
        family: 4,
      },
    ]);

    await expect(
      fetchHtml("https://public.example/", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost,
      }),
    ).rejects.toThrow("Refusing to fetch private.example: resolves to a non-public address");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects more than five redirects", async () => {
    let redirect = 0;
    const fetchImpl = vi.fn(async () => {
      redirect += 1;
      return new Response(null, { status: 302, headers: { location: `/hop-${redirect}` } });
    });

    await expect(
      fetchHtml("https://example.com/", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toThrow("Too many redirects (>5)");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("aborts and cancels a body that exceeds the 10 MB cap without a content-length", async () => {
    let cancelled = false;
    const oneMb = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(oneMb);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));

    await expect(
      fetchHtml("https://big.example/", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toThrow("Page HTML exceeds the 10 MB audit limit");
    expect(cancelled).toBe(true);
  });

  it("decodes a non-UTF-8 body using the Content-Type charset", async () => {
    const body = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in windows-1252 (é = 0xE9)
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/html; charset=windows-1252" },
        }),
    );

    const result = await fetchHtml("https://fr.example/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.html).toBe("café");
  });

  it("falls back to a <meta charset> when the header omits one", async () => {
    const prefix = new TextEncoder().encode(`<meta charset="windows-1252"><p>`);
    const body = new Uint8Array([...prefix, 0x63, 0x61, 0x66, 0xe9]); // ...café
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));

    const result = await fetchHtml("https://fr.example/", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.html).toContain("café");
  });

  it("decompresses a gzipped sitemap body", async () => {
    const body = gzipSync(Buffer.from("<urlset><url><loc>https://e.com/</loc></url></urlset>"));
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        }),
    );

    const result = await fetchHtml("https://e.com/sitemap.xml.gz", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.html).toContain("<urlset>");
  });

  it("rejects a body that carries the gzip magic bytes but will not inflate", async () => {
    const body = new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02]);
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));

    await expect(
      fetchHtml("https://e.com/sitemap.xml.gz", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toThrow(/could not be decompressed/);
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
