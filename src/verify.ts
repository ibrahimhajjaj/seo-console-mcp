import { google } from "googleapis";
import { createCloudflareClient, type CloudflareClient } from "./cloudflare.js";

export interface VerifyClients {
  getToken(domain: string): Promise<string>;
  verifyOwnership(domain: string): Promise<void>;
  addSite(domain: string): Promise<void>;
}

export interface VerifyOptions {
  credentialsPath?: string;
  cloudflareToken?: string;
  print?: (line: string) => void;
  clients?: VerifyClients;
  cloudflare?: CloudflareClient;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}

interface VerifyDeps {
  clients: VerifyClients;
  cloudflare: CloudflareClient;
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  attempts: number;
  delayMs: number;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; response?: { status?: unknown } };
  const raw = record.response?.status ?? record.code;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

export async function runVerify(domains: string[], options: VerifyOptions = {}): Promise<boolean> {
  const print = options.print ?? console.log;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 12000;

  const clients = options.clients ?? createVerifyClients(options.credentialsPath);
  let cloudflare = options.cloudflare;
  if (!cloudflare) {
    const cfToken = options.cloudflareToken ?? process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
    if (!cfToken) {
      print("A Cloudflare API token is required. Set CLOUDFLARE_API_TOKEN (scoped to Zone.DNS:Edit) or pass --cf-token.");
      return false;
    }
    cloudflare = createCloudflareClient(cfToken);
  }

  let allOk = true;
  for (const domain of domains) {
    const ok = await verifyDomain(domain, { clients, cloudflare, print, sleep, attempts, delayMs });
    if (!ok) allOk = false;
  }
  return allOk;
}

async function verifyDomain(domain: string, deps: VerifyDeps): Promise<boolean> {
  const { clients, cloudflare, print, sleep, attempts, delayMs } = deps;
  try {
    print("");
    print(domain);
    const token = await clients.getToken(domain);
    print("[1/4] Got verification token from Google.");

    const zoneId = await cloudflare.findZoneId(domain);
    const state = await cloudflare.ensureTxtRecord(zoneId, domain, token);
    print(`[2/4] TXT record ${state === "created" ? "created" : "already present"} on Cloudflare.`);

    print("[3/4] Verifying ownership (waiting for DNS to propagate)...");
    let lastError = "";
    let verified = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await clients.verifyOwnership(domain);
        verified = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const status = httpStatus(error);
        if (status === 401 || status === 403) {
          print(`[3/4] Verification cannot proceed: ${lastError}`);
          return false;
        }
        if (attempt < attempts) await sleep(delayMs);
      }
    }
    if (!verified) {
      print(`[3/4] Not verified yet: ${lastError}`);
      print(`      The TXT record is in place. Re-run \`seo-mcp verify ${domain}\` in a few minutes; it is idempotent.`);
      return false;
    }
    print("[3/4] Ownership verified. The service account is now an owner.");

    try {
      await clients.addSite(domain);
      print(`[4/4] Added sc-domain:${domain} to Search Console.`);
    } catch (error) {
      const status = httpStatus(error);
      const message = error instanceof Error ? error.message : String(error);
      // 409 is the plain conflict; a 400 is only "already added" when the message
      // says so, otherwise it is a real malformed-request failure we must surface.
      const alreadyPresent = status === 409 || (status === 400 && /already|exist/i.test(message));
      if (alreadyPresent) {
        print(`[4/4] sc-domain:${domain} is already in Search Console.`);
      } else {
        print(`[4/4] Ownership verified, but adding sc-domain:${domain} to Search Console failed: ${message}`);
        return false;
      }
    }
    print(`Done. Query it with siteUrl "sc-domain:${domain}".`);
    return true;
  } catch (error) {
    print(`Failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function createVerifyClients(credentialsPath?: string): VerifyClients {
  const auth = new google.auth.GoogleAuth({
    ...(credentialsPath ? { keyFile: credentialsPath } : {}),
    scopes: [
      "https://www.googleapis.com/auth/siteverification",
      "https://www.googleapis.com/auth/webmasters",
    ],
  });
  const siteVerification = google.siteVerification({ version: "v1", auth });
  const searchConsole = google.searchconsole({ version: "v1", auth });
  return {
    async getToken(domain) {
      const response = await siteVerification.webResource.getToken({
        requestBody: { site: { type: "INET_DOMAIN", identifier: domain }, verificationMethod: "DNS_TXT" },
      });
      const token = response.data.token;
      if (!token) throw new Error("Google did not return a verification token.");
      return token;
    },
    async verifyOwnership(domain) {
      await siteVerification.webResource.insert({
        verificationMethod: "DNS_TXT",
        requestBody: { site: { type: "INET_DOMAIN", identifier: domain } },
      });
    },
    async addSite(domain) {
      await searchConsole.sites.add({ siteUrl: `sc-domain:${domain}` });
    },
  };
}
