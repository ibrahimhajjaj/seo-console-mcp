import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { appStoreReviewsInput } from "./schemas.js";
import { ascGet, resolveAppId, readCredentialsFromEnv, createAscToken, type AscCredentials } from "./app-store-listing.js";

type ReviewParams = z.output<typeof appStoreReviewsInput>;

interface ReviewDeps {
  fetchImpl?: typeof fetch;
  credentials?: AscCredentials;
  now?: Date;
}

const PAGE_LIMIT = 200;

export async function appStoreReviews(params: ReviewParams, deps: ReviewDeps = {}): Promise<ToolResult> {
  if (!params.appId && !params.bundleId) {
    throw new Error("Provide appId or bundleId to identify the app.");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const credentials = deps.credentials ?? readCredentialsFromEnv();
  const token = createAscToken(credentials, deps.now ?? new Date());
  const appId = params.appId ?? (await resolveAppId(params.bundleId as string, token, fetchImpl));

  const query = new URLSearchParams({
    limit: String(Math.min(params.limit, PAGE_LIMIT)),
    sort: params.sort,
    include: "response",
  });
  if (params.rating?.length) query.set("filter[rating]", params.rating.join(","));
  if (params.territory) query.set("filter[territory]", params.territory);

  const reviews: Array<Record<string, unknown>> = [];
  const responsesById = new Map<string, Record<string, unknown>>();
  let path: string | null = `/v1/apps/${appId}/customerReviews?${query.toString()}`;
  let pagesRead = 0;

  while (path && reviews.length < params.limit && pagesRead < params.maxPages) {
    const page = await ascGet(path, token, fetchImpl);
    pagesRead += 1;
    for (const included of page.included ?? []) {
      if (included.type === "customerReviewResponses") responsesById.set(included.id, included.attributes ?? {});
    }
    for (const entry of asArray(page.data)) {
      const attributes = entry.attributes ?? {};
      const responseId = (entry as { relationships?: { response?: { data?: { id?: string } } } }).relationships?.response?.data?.id;
      const response = responseId ? responsesById.get(responseId) : undefined;
      reviews.push({
        id: entry.id,
        rating: numberOrNull(attributes.rating),
        title: stringOrNull(attributes.title),
        body: stringOrNull(attributes.body),
        reviewerNickname: stringOrNull(attributes.reviewerNickname),
        createdDate: stringOrNull(attributes.createdDate),
        territory: stringOrNull(attributes.territory),
        respondedAt: response ? stringOrNull(response.lastModifiedDate) : null,
        responseBody: response ? stringOrNull(response.responseBody) : null,
      });
      if (reviews.length >= params.limit) break;
    }
    // JSON:API cursor paging: follow the server's own next link rather than
    // constructing offsets, which Apple does not use.
    const next = page.links?.next;
    path = next ? next.replace("https://api.appstoreconnect.apple.com", "") : null;
  }

  const rated = reviews.map((review) => review.rating).filter((rating): rating is number => typeof rating === "number");
  const histogram: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const rating of rated) {
    const bucket = String(Math.round(rating));
    if (bucket in histogram) histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
  const withoutResponse = reviews.filter((review) => !review.responseBody).length;

  const structuredContent = {
    appId,
    bundleId: params.bundleId ?? null,
    returned: reviews.length,
    pagesRead,
    // This is the mean of the reviews actually fetched, not the App Store's
    // lifetime star rating. Apple exposes no aggregate rating resource, and a
    // filtered or truncated page would make this a different number entirely.
    meanOfFetched: rated.length ? rated.reduce((total, rating) => total + rating, 0) / rated.length : null,
    histogramOfFetched: histogram,
    withoutResponse,
    filters: {
      rating: params.rating ?? null,
      territory: params.territory ?? null,
      sort: params.sort,
    },
    reviews,
    notes: [
      "meanOfFetched and histogramOfFetched describe only the reviews returned by this call, not the app's lifetime rating. App Store Connect exposes no aggregate rating resource.",
      ...(reviews.length >= params.limit ? ["The limit was reached, so older reviews exist beyond this page."] : []),
    ],
  };

  const lines = [
    `${reviews.length} review(s) for app ${appId}${params.territory ? ` in ${params.territory}` : ""}`,
    `Mean of these ${reviews.length}: ${structuredContent.meanOfFetched?.toFixed(2) ?? "unknown"} (not the lifetime App Store rating)`,
    `Star split of these: ${Object.entries(histogram).map(([star, count]) => `${star}★ ${count}`).join(", ")}`,
    `${withoutResponse} of them have no developer response.`,
  ];
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent };
}

function asArray(data: unknown): Array<{ type: string; id: string; attributes?: Record<string, unknown> }> {
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]) as Array<{ type: string; id: string; attributes?: Record<string, unknown> }>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
