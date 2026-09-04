import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import { keywordIdeaExpansions, type keywordIdeasInput } from "./schemas.js";
import { USER_AGENT } from "./version.js";

type KeywordIdeasParams = z.output<typeof keywordIdeasInput>;
type Expansion = (typeof keywordIdeaExpansions)[number];
type Family = "seed" | Expansion;

export interface KeywordIdeasGscRow {
  keys?: string[] | null;
  position?: number | null;
  clicks?: number | null;
  impressions?: number | null;
}

interface GscQueryRequest {
  siteUrl: string;
  requestBody: {
    startDate: string;
    endDate: string;
    dimensions: ["query"];
    rowLimit: 5000;
  };
}

export interface KeywordIdeasDependencies {
  fetchImpl?: typeof fetch;
  fetchGscRows?: (request: GscQueryRequest) => Promise<KeywordIdeasGscRow[]>;
  now?: Date;
}

interface AutocompleteRequest {
  query: string;
  family: Family;
}

interface Idea {
  keyword: string;
  family: Family;
  discoveryIndex: number;
  gsc: { position: number; clicks: number; impressions: number } | null;
}

const AUTOCOMPLETE_URL = "https://suggestqueries.google.com/complete/search";
const AUTOCOMPLETE_TIMEOUT_MS = 15_000;
const QUESTION_PREFIXES = ["how", "what", "why", "when", "where", "which", "who", "can", "is", "does"];
const PREPOSITIONS = ["for", "with", "without", "vs", "near", "to", "like"];

export async function keywordIdeas(params: KeywordIdeasParams, deps: KeywordIdeasDependencies = {}): Promise<ToolResult> {
  const requests = autocompleteRequests(params.seed, params.expansions);
  const responses = await fetchAutocomplete(requests, params, deps.fetchImpl ?? fetch);
  const requestFailures = responses.filter((response) => response === null).length;
  if (requestFailures === requests.length) {
    throw new Error("Every Google Autocomplete request failed. Try again later or reduce the expansion families.");
  }

  const normalizedSeed = normalizeKeyword(params.seed);
  const seen = new Set<string>();
  const ideas: Idea[] = [];
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex];
    const suggestions = responses[requestIndex];
    if (!request || !suggestions) continue;
    for (const suggestion of suggestions) {
      const keyword = normalizeKeyword(suggestion);
      if (!keyword || keyword === normalizedSeed || seen.has(keyword)) continue;
      seen.add(keyword);
      ideas.push({ keyword, family: request.family, discoveryIndex: ideas.length, gsc: null });
    }
  }

  if (params.siteUrl) {
    if (!deps.fetchGscRows) throw new Error("Search Console query access is required when siteUrl is provided.");
    const rows = await deps.fetchGscRows(gscRequest(params.siteUrl, params.days, deps.now ?? new Date()));
    const byQuery = new Map<string, KeywordIdeasGscRow>();
    for (const row of rows) {
      const query = normalizeKeyword(row.keys?.[0] ?? "");
      if (query && !byQuery.has(query)) byQuery.set(query, row);
    }
    for (const idea of ideas) {
      const row = byQuery.get(idea.keyword);
      if (!row) continue;
      idea.gsc = {
        position: row.position ?? 0,
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
      };
    }
  }

  ideas.sort((left, right) => {
    if (left.gsc && right.gsc) return left.gsc.position - right.gsc.position || left.discoveryIndex - right.discoveryIndex;
    if (left.gsc) return -1;
    if (right.gsc) return 1;
    return left.discoveryIndex - right.discoveryIndex;
  });

  const totalFound = ideas.length;
  const gscMatched = ideas.filter((idea) => idea.gsc !== null).length;
  const returnedIdeas = ideas.slice(0, params.limit).map(({ discoveryIndex: _, ...idea }) => idea);
  const structuredContent = {
    seed: params.seed,
    totalFound,
    returned: returnedIdeas.length,
    requestFailures,
    gscMatched,
    crossReferenced: Boolean(params.siteUrl),
    ideas: returnedIdeas,
  };
  return result(formatSummary(params.seed, ideas, returnedIdeas, requestFailures), structuredContent);
}

function autocompleteRequests(seed: string, expansions: Expansion[]): AutocompleteRequest[] {
  const enabled = new Set(expansions);
  const requests: AutocompleteRequest[] = [{ query: seed, family: "seed" }];
  if (enabled.has("alphabet")) {
    for (let code = 97; code <= 122; code += 1) requests.push({ query: `${seed} ${String.fromCharCode(code)}`, family: "alphabet" });
  }
  if (enabled.has("questions")) {
    requests.push(...QUESTION_PREFIXES.map((prefix) => ({ query: `${prefix} ${seed}`, family: "questions" as const })));
  }
  if (enabled.has("prepositions")) {
    requests.push(...PREPOSITIONS.map((preposition) => ({ query: `${seed} ${preposition}`, family: "prepositions" as const })));
  }
  if (enabled.has("comparisons")) {
    requests.push({ query: `${seed} vs`, family: "comparisons" }, { query: `best ${seed}`, family: "comparisons" }, { query: `${seed} alternative`, family: "comparisons" });
  }
  return requests;
}

async function fetchAutocomplete(requests: AutocompleteRequest[], params: KeywordIdeasParams, fetchImpl: typeof fetch): Promise<Array<string[] | null>> {
  const responses: Array<string[] | null> = Array.from({ length: requests.length }, () => null);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < requests.length) {
      const index = nextIndex;
      nextIndex += 1;
      const request = requests[index];
      if (!request) continue;
      try {
        const url = new URL(AUTOCOMPLETE_URL);
        url.searchParams.set("client", "firefox");
        url.searchParams.set("q", request.query);
        url.searchParams.set("hl", params.language);
        if (params.country) url.searchParams.set("gl", params.country);
        const response = await fetchImpl(url.toString(), {
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(AUTOCOMPLETE_TIMEOUT_MS),
        });
        if (response.status !== 200) continue;
        const body: unknown = await response.json();
        if (!Array.isArray(body) || !Array.isArray(body[1])) continue;
        responses[index] = body[1].filter((suggestion): suggestion is string => typeof suggestion === "string");
      } catch {
        // Individual requests are best-effort; the aggregate failure is reported below.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, requests.length) }, () => worker()));
  return responses;
}

function gscRequest(siteUrl: string, days: number, now: Date): GscQueryRequest {
  const endDate = new Date(now);
  const startDate = new Date(now);
  startDate.setUTCDate(startDate.getUTCDate() - days + 1);
  return {
    siteUrl,
    requestBody: {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      dimensions: ["query"],
      rowLimit: 5000,
    },
  };
}

function normalizeKeyword(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function formatSummary(seed: string, allIdeas: Idea[], returnedIdeas: Array<Omit<Idea, "discoveryIndex">>, requestFailures: number): string {
  const counts = ["seed", ...keywordIdeaExpansions].map((family) => `${family}: ${allIdeas.filter((idea) => idea.family === family).length}`);
  const ranking = returnedIdeas
    .filter((idea) => idea.gsc)
    .slice(0, 5)
    .map((idea) => `- ${idea.keyword} (position ${idea.gsc?.position.toFixed(2)})`);
  const netNew = returnedIdeas
    .filter((idea) => !idea.gsc)
    .slice(0, 10)
    .map((idea) => `- ${idea.keyword}`);
  return [
    `Keyword ideas for ${seed}: ${allIdeas.length} found, ${returnedIdeas.length} returned; ${requestFailures} autocomplete request(s) failed.`,
    `Families: ${counts.join(", ")}`,
    "Already ranking:",
    ...(ranking.length ? ranking : ["- None"]),
    "Top net-new ideas:",
    ...(netNew.length ? netNew : ["- None"]),
  ].join("\n");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function result(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}
