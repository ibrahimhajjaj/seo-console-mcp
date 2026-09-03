import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchHtml } from "../src/fetch-page.js";

// Every other fetchHtml test injects fetchImpl, so the undici Agent that pins
// the socket to a validated address never actually runs. These cases use the
// real fetch against a loopback listener, which makes this the one place in the
// suite that opens a socket, because the claim being tested is about Node
// itself: that it honors an Agent passed as init.dispatcher. If a supported
// runtime ignored it, the hostname pre-check would be the only defense left and
// nothing else here would notice.

// undici reports a connect-time failure as "TypeError: fetch failed" and hangs
// the real reason off cause, so the message that tells a refused rebinding
// answer apart from a plain DNS miss is never on the top-level error.
function causeChain(error: unknown): string {
  const messages: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  return messages.join(" <- ");
}

describe("fetchHtml dispatcher", () => {
  const requests: string[] = [];
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<title>ok</title>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
  });

  it("refuses a connect-time answer that rebinds to loopback", async () => {
    const outcome = await fetchHtml(`http://host.test:${port}/`, {
      // The pre-check is handed a public address and passes; the socket is then
      // handed loopback. That split is the rebinding shape, and only a dispatcher
      // that is actually honored can catch it.
      lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
      connectResolver: (_hostname, _options, callback) => {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    }).catch((reason: unknown) => reason);
    const chain = causeChain(outcome);

    expect(outcome).toBeInstanceOf(Error);
    expect(chain).toMatch(/non-public address/);
    // ENOTFOUND instead would mean the dispatcher was skipped and the system
    // resolver ran, failing on the unresolvable name for an unrelated reason.
    expect(chain).not.toMatch(/ENOTFOUND/);
    expect(requests).toHaveLength(0);
  });

  it("reaches the loopback listener when private hosts are allowed", async () => {
    // The control for the case above: it proves the fixture is reachable over
    // the un-injected fetch, so "zero requests" there means the connection was
    // refused rather than that the server was never listening.
    const result = await fetchHtml(`http://127.0.0.1:${port}/`, { allowPrivateHosts: true });

    expect(result.status).toBe(200);
    expect(result.html).toContain("<title>ok</title>");
    expect(requests).toHaveLength(1);
  });
});
