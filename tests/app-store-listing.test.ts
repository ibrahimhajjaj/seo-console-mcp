import { describe, expect, it, vi } from "vitest";
import { createPublicKey, generateKeyPairSync, verify as verifyWithKey } from "node:crypto";
import { appStoreListing, createAscToken, type AscCredentials } from "../src/app-store-listing.js";
import { appStoreListingInput, appStoreListingOutput } from "../src/schemas.js";

function credentials(overrides: Partial<AscCredentials> = {}): AscCredentials {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    keyId: "ABC123DEFG",
    issuerId: "69a6de70-0000-0000-0000-5b8d9eaa1279",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ...overrides,
  };
}

function params(overrides: Record<string, unknown> = {}) {
  return appStoreListingInput.parse({ appId: "1234567890", ...overrides });
}

const LIVE_INFO = { type: "appInfos", id: "info-live", attributes: { state: "READY_FOR_DISTRIBUTION" } };
const DRAFT_INFO = { type: "appInfos", id: "info-draft", attributes: { state: "PREPARE_FOR_SUBMISSION" } };
const LIVE_VERSION = { type: "appStoreVersions", id: "v-live", attributes: { appVersionState: "READY_FOR_DISTRIBUTION", versionString: "1.4.0" } };
const DRAFT_VERSION = { type: "appStoreVersions", id: "v-draft", attributes: { appVersionState: "PREPARE_FOR_SUBMISSION", versionString: "1.5.0" } };

function localization(type: string, id: string, attributes: Record<string, unknown>, relationships?: Record<string, unknown>) {
  return { type, id, attributes, ...(relationships ? { relationships } : {}) };
}

interface RouteOptions {
  infos?: unknown[];
  versions?: unknown[];
  infoLocalizations?: Record<string, unknown[]>;
  versionLocalizations?: Record<string, unknown[]>;
  itunes?: unknown;
}

function fakeFetch(options: RouteOptions = {}) {
  const infos = options.infos ?? [LIVE_INFO];
  const versions = options.versions ?? [LIVE_VERSION];
  const infoLocalizations = options.infoLocalizations ?? {
    "info-live": [localization("appInfoLocalizations", "il-en", { locale: "en-US", name: "Psst", subtitle: "Shared lists" })],
    "info-draft": [localization("appInfoLocalizations", "il-en-d", { locale: "en-US", name: "DRAFT NAME", subtitle: "draft subtitle" })],
  };
  const versionLocalizations = options.versionLocalizations ?? {
    "v-live": [localization("appStoreVersionLocalizations", "vl-en", { locale: "en-US", keywords: "lists,shared", promotionalText: "New", description: "Desc." })],
    "v-draft": [localization("appStoreVersionLocalizations", "vl-en-d", { locale: "en-US", keywords: "draft,keywords", promotionalText: "Draft promo", description: "Draft desc." })],
  };

  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("itunes.apple.com")) {
      return new Response(JSON.stringify(options.itunes ?? { results: [{ averageUserRating: 4.5, userRatingCount: 12 }] }), { status: 200 });
    }
    if (url.includes("/v1/apps?")) return new Response(JSON.stringify({ data: [{ type: "apps", id: "1234567890" }] }), { status: 200 });
    if (url.includes("/appInfoLocalizations")) {
      const id = url.match(/appInfos\/([^/]+)\//)?.[1] ?? "";
      return new Response(JSON.stringify({ data: infoLocalizations[id] ?? [] }), { status: 200 });
    }
    if (url.includes("/appStoreVersionLocalizations")) {
      const id = url.match(/appStoreVersions\/([^/]+)\//)?.[1] ?? "";
      return new Response(JSON.stringify({ data: versionLocalizations[id] ?? [] }), { status: 200 });
    }
    if (url.includes("/appInfos")) return new Response(JSON.stringify({ data: infos }), { status: 200 });
    if (url.includes("/appStoreVersions")) return new Response(JSON.stringify({ data: versions }), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

describe("createAscToken", () => {
  it("signs a verifiable ES256 token with the team-key claims", () => {
    const creds = credentials();

    const token = createAscToken(creds, new Date("2026-07-14T00:00:00Z"));

    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    const header = JSON.parse(Buffer.from(encodedHeader ?? "", "base64url").toString());
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString());
    expect(header).toEqual({ alg: "ES256", kid: creds.keyId, typ: "JWT" });
    expect(payload).toMatchObject({ iss: creds.issuerId, aud: "appstoreconnect-v1" });
    expect(payload.sub).toBeUndefined();
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(1200);

    // Apple requires the raw r||s form: exactly 64 bytes for P-256, not DER.
    const signature = Buffer.from(encodedSignature ?? "", "base64url");
    expect(signature).toHaveLength(64);
    expect(verifyWithKey(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: createPublicKey(creds.privateKey), dsaEncoding: "ieee-p1363" },
      signature,
    )).toBe(true);
  });

  it("identifies an individual key with sub instead of iss", () => {
    const creds = credentials({ issuerId: undefined });

    const token = createAscToken(creds, new Date("2026-07-14T00:00:00Z"));

    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    expect(payload).toMatchObject({ sub: "user", aud: "appstoreconnect-v1" });
    expect(payload.iss).toBeUndefined();
  });
});

describe("appStoreListing", () => {
  it("reads the live record when both a live and an editable one exist", async () => {
    const fetchImpl = fakeFetch({ infos: [DRAFT_INFO, LIVE_INFO], versions: [DRAFT_VERSION, LIVE_VERSION] });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });

    expect(result.structuredContent).toMatchObject({
      appInfoState: "READY_FOR_DISTRIBUTION",
      versionState: "READY_FOR_DISTRIBUTION",
      versionString: "1.4.0",
      requestedState: "live",
    });
    const locales = (result.structuredContent as { locales: Array<Record<string, any>> }).locales;
    expect(locales[0]?.indexed.name.text).toBe("Psst");
    expect(locales[0]?.indexed.keywords.text).toBe("lists,shared");
  });

  it("reads the editable record when asked, so unshipped copy can be checked", async () => {
    const fetchImpl = fakeFetch({ infos: [LIVE_INFO, DRAFT_INFO], versions: [LIVE_VERSION, DRAFT_VERSION] });

    const result = await appStoreListing(params({ state: "editable" }), { fetchImpl, credentials: credentials() });

    expect(result.structuredContent).toMatchObject({ appInfoState: "PREPARE_FOR_SUBMISSION", versionString: "1.5.0" });
    const locales = (result.structuredContent as { locales: Array<Record<string, any>> }).locales;
    expect(locales[0]?.indexed.name.text).toBe("DRAFT NAME");
    expect(locales[0]?.indexed.keywords.text).toBe("draft,keywords");
  });

  it("says so when it falls back to the other record", async () => {
    const fetchImpl = fakeFetch({ infos: [LIVE_INFO], versions: [LIVE_VERSION] });

    const result = await appStoreListing(params({ state: "editable" }), { fetchImpl, credentials: credentials() });

    const notes = (result.structuredContent as { notes: string[] }).notes;
    expect(notes.join(" ")).toMatch(/No editable app info exists/);
  });

  it("does not call a superseded version a draft", async () => {
    // An app that has shipped twice has historical versions in
    // REPLACED_WITH_NEW_VERSION. Those are not drafts, and reading them as one
    // would report "a draft exists" for every established app forever.
    const superseded = { type: "appStoreVersions", id: "v-old", attributes: { appVersionState: "REPLACED_WITH_NEW_VERSION", versionString: "1.3.0" } };
    const fetchImpl = fakeFetch({ infos: [LIVE_INFO], versions: [LIVE_VERSION, superseded] });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });

    expect(result.structuredContent).toMatchObject({
      hasLiveRecord: true,
      hasEditableRecord: false,
      fellBack: false,
      versionString: "1.4.0",
    });
  });

  it("reports a real draft as one", async () => {
    const fetchImpl = fakeFetch({ infos: [LIVE_INFO, DRAFT_INFO], versions: [LIVE_VERSION, DRAFT_VERSION] });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });

    expect(result.structuredContent).toMatchObject({ hasLiveRecord: true, hasEditableRecord: true, fellBack: false });
  });

  it("does not treat an unreadable state as a draft", async () => {
    const stateless = { type: "appStoreVersions", id: "v-x", attributes: { versionString: "9.9.9" } };
    const fetchImpl = fakeFetch({ infos: [LIVE_INFO], versions: [LIVE_VERSION, stateless] });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });

    expect(result.structuredContent).toMatchObject({ hasEditableRecord: false });
  });

  it("filters versions by platform", async () => {
    const fetchImpl = fakeFetch();

    await appStoreListing(params({ platform: "MAC_OS" }), { fetchImpl, credentials: credentials() });

    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("filter%5Bplatform%5D=MAC_OS"))).toBe(true);
  });

  it("measures indexed fields against Apple's limits and flags over-limit ones", async () => {
    const fetchImpl = fakeFetch({
      infoLocalizations: { "info-live": [localization("appInfoLocalizations", "il", { locale: "en-US", name: "Fine", subtitle: "x".repeat(31) })] },
    });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });

    const locales = (result.structuredContent as { locales: Array<Record<string, any>> }).locales;
    expect(locales[0]?.indexed.name).toEqual({ text: "Fine", length: 4, limit: 30, overLimit: false });
    expect(locales[0]?.indexed.subtitle).toMatchObject({ length: 31, limit: 30, overLimit: true });
    expect((result.structuredContent as { overLimit: string[] }).overLimit).toContain("en-US subtitle");
    expect(result.content[0]?.text).toContain("Over limit");
  });

  it("marks a locale present in only one record as partial", async () => {
    const fetchImpl = fakeFetch({
      versionLocalizations: {
        "v-live": [
          localization("appStoreVersionLocalizations", "vl-en", { locale: "en-US", keywords: "a", promotionalText: "b", description: "c" }),
          localization("appStoreVersionLocalizations", "vl-de", { locale: "de-DE", keywords: "d", promotionalText: "e", description: "f" }),
        ],
      },
    });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });

    const locales = (result.structuredContent as { locales: Array<Record<string, any>> }).locales;
    expect(locales.find((entry) => entry.locale === "de-DE")?.partial).toBe(true);
    expect(locales.find((entry) => entry.locale === "en-US")?.partial).toBe(false);
    expect((result.structuredContent as { notes: string[] }).notes.join(" ")).toMatch(/only one record/);
  });

  it("resolves a bundle id to an app id", async () => {
    const fetchImpl = fakeFetch();

    const result = await appStoreListing(appStoreListingInput.parse({ bundleId: "app.getpsst" }), { fetchImpl, credentials: credentials() });

    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("filter%5BbundleId%5D=app.getpsst"))).toBe(true);
    expect(result.structuredContent).toMatchObject({ appId: "1234567890", bundleId: "app.getpsst" });
  });

  it("requires an appId or a bundleId", async () => {
    await expect(
      appStoreListing(appStoreListingInput.parse({}), { fetchImpl: fakeFetch(), credentials: credentials() }),
    ).rejects.toThrow(/appId or bundleId/);
  });

  it("reports a credentials rejection distinctly from other failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));

    await expect(appStoreListing(params(), { fetchImpl, credentials: credentials() })).rejects.toThrow(/rejected the credentials/);
  });

  it("reports a failed ratings lookup as unknown rather than as no ratings", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("itunes.apple.com")) return new Response("rate limited", { status: 429 });
      return fakeFetch()(input);
    });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });

    expect((result.structuredContent as { notes: string[] }).notes.join(" ")).toMatch(/ratings lookup for us failed/);
    expect((result.structuredContent as { ratings: unknown[] }).ratings).toEqual([{ storefront: "us", averageUserRating: null, userRatingCount: null }]);
  });

  it("matches its declared output schema", async () => {
    const fetchImpl = fakeFetch();

    const result = await appStoreListing(params({ storefronts: ["us", "eg"] }), { fetchImpl, credentials: credentials() });

    expect(() => appStoreListingOutput.parse(result.structuredContent)).not.toThrow();
  });

  it("never puts the signing key or the bearer token in output or errors", async () => {
    const creds = credentials();
    const now = new Date("2026-07-14T00:00:00Z");
    const token = createAscToken(creds, now);
    const signature = token.split(".")[2] as string;

    const ok = await appStoreListing(params(), { fetchImpl: fakeFetch(), credentials: creds, now });
    const serialized = JSON.stringify(ok);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(signature);
    expect(serialized).not.toContain(creds.privateKey.split("\n")[1] as string);

    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    const error = await appStoreListing(params(), { fetchImpl: failing, credentials: creds, now }).catch((caught: Error) => caught);
    const message = (error as Error).message;
    expect(message).not.toContain(token);
    expect(message).not.toContain(signature);
    expect(message).not.toContain(creds.privateKey.split("\n")[1] as string);
  });
});

describe("appStoreListing assets", () => {
  it("reads screenshot sets from the localization linkage and names locales without any", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("itunes.apple.com")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      if (url.includes("/appInfoLocalizations")) {
        return new Response(JSON.stringify({ data: [
          { type: "appInfoLocalizations", id: "a", attributes: { locale: "en-GB", name: "N", subtitle: "S" } },
          { type: "appInfoLocalizations", id: "b", attributes: { locale: "fr-FR", name: "N", subtitle: "S" } },
        ] }), { status: 200 });
      }
      if (url.includes("/appStoreVersionLocalizations")) {
        return new Response(JSON.stringify({
          data: [
            { type: "appStoreVersionLocalizations", id: "vl-en", attributes: { locale: "en-GB", keywords: "k" },
              relationships: { appScreenshotSets: { data: [{ type: "appScreenshotSets", id: "s1" }] }, appPreviewSets: { data: [] } } },
            { type: "appStoreVersionLocalizations", id: "vl-fr", attributes: { locale: "fr-FR", keywords: "k" },
              relationships: { appScreenshotSets: { data: [] }, appPreviewSets: { data: [] } } },
          ],
          included: [{ type: "appScreenshotSets", id: "s1", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }],
        }), { status: 200 });
      }
      if (url.includes("/appInfos")) return new Response(JSON.stringify({ data: [LIVE_INFO] }), { status: 200 });
      return new Response(JSON.stringify({ data: [LIVE_VERSION] }), { status: 200 });
    });

    const result = await appStoreListing(params(), { fetchImpl, credentials: credentials() });
    const content = result.structuredContent as Record<string, any>;

    expect(content.locales.find((l: any) => l.locale === "en-GB").screenshotSets).toEqual(["APP_IPHONE_67"]);
    expect(content.locales.find((l: any) => l.locale === "fr-FR").screenshotSets).toEqual([]);
    expect(content.notes.join(" ")).toMatch(/no screenshots of their own.*fr-FR/);
  });
});
