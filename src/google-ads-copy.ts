import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { adsAdCopyInput } from "./schemas.js";
import { quoteGaql, type AdsClient } from "./google-ads.js";

type Params = z.output<typeof adsAdCopyInput>;

// Google's own thresholds for a responsive search ad. Falling short of them is
// the most common reason strength comes back Poor, and the count is something
// the caller can act on in a way the word "Poor" is not.
const WANTED_HEADLINES = 15;
const WANTED_DESCRIPTIONS = 4;

interface TextAsset {
  text: string;
  pinned: string | null;
  performance: string | null;
}

// Google writes an unset enum as the literal UNSPECIFIED or UNKNOWN rather than
// leaving the field out, and carrying those through would read as a real value.
function enumOrNull(value: unknown): string | null {
  const text = String(value ?? "");
  return !text || text === "UNSPECIFIED" || text === "UNKNOWN" ? null : text;
}

function assets(raw: unknown): TextAsset[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: Record<string, any>) => ({
      text: String(entry?.text ?? ""),
      pinned: enumOrNull(entry?.pinnedField),
      performance: enumOrNull(entry?.performanceLabel ?? entry?.assetPerformanceLabel),
    }))
    .filter((asset) => asset.text);
}

function observe(type: string, headlines: TextAsset[], descriptions: TextAsset[]): string[] {
  const observations: string[] = [];
  if (type !== "RESPONSIVE_SEARCH_AD") {
    observations.push(`This is a ${type || "an unnamed"} ad, so its text is not in the responsive search ad fields and is not reported here.`);
    return observations;
  }

  observations.push(`${headlines.length} of ${WANTED_HEADLINES} headlines, ${descriptions.length} of ${WANTED_DESCRIPTIONS} descriptions.`);
  const pinnedHeadlines = headlines.filter((asset) => asset.pinned).length;
  const pinnedDescriptions = descriptions.filter((asset) => asset.pinned).length;
  if (pinnedHeadlines || pinnedDescriptions) {
    // Pinning is usually deliberate and usually invisible in the strength word,
    // so it is stated rather than judged.
    observations.push(`${pinnedHeadlines} headline(s) and ${pinnedDescriptions} description(s) are pinned, which limits the combinations Google can build and commonly shows up as lower strength.`);
  }

  const seen = new Map<string, number>();
  for (const asset of [...headlines, ...descriptions]) {
    const key = asset.text.trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeated = [...seen].filter(([, count]) => count > 1).map(([text]) => text);
  if (repeated.length) observations.push(`Repeated inside this ad: ${repeated.map((text) => `"${text}"`).join(", ")}. A repeated asset takes a slot without adding a variation.`);

  return observations;
}

export async function adsAdCopy(api: AdsClient, params: Params): Promise<ToolResult> {
  const conditions: string[] = [];
  if (!params.includeRemoved) conditions.push("ad_group_ad.status != 'REMOVED'");
  if (params.adGroup) conditions.push(`ad_group.name = ${quoteGaql(params.adGroup)}`);
  if (params.adId) conditions.push(`ad_group_ad.ad.id = ${Number(params.adId)}`);

  const rows = await api.gaql(
    `SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type,
            ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions,
            ad_group_ad.ad.responsive_search_ad.path1,
            ad_group_ad.ad.responsive_search_ad.path2,
            ad_group_ad.ad.final_urls,
            ad_group_ad.status, ad_group_ad.ad_strength,
            ad_group_ad.policy_summary.approval_status,
            ad_group_ad.policy_summary.policy_topic_entries
     FROM ad_group_ad${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`,
  );

  const ads = rows.map((row) => {
    const adGroupAd = (row.adGroupAd ?? {}) as Record<string, any>;
    const ad = (adGroupAd.ad ?? {}) as Record<string, any>;
    const responsive = (ad.responsiveSearchAd ?? {}) as Record<string, any>;
    const type = String(ad.type ?? "");
    const headlines = assets(responsive.headlines);
    const descriptions = assets(responsive.descriptions);
    return {
      adId: String(ad.id ?? ""),
      adGroup: String(row.adGroup?.name ?? ""),
      campaign: String(row.campaign?.name ?? ""),
      type,
      status: String(adGroupAd.status ?? ""),
      adStrength: String(adGroupAd.adStrength ?? ""),
      approvalStatus: String(adGroupAd.policySummary?.approvalStatus ?? ""),
      headlines,
      descriptions,
      paths: [responsive.path1, responsive.path2].map((part) => String(part ?? "")).filter(Boolean),
      finalUrls: Array.isArray(ad.finalUrls) ? ad.finalUrls.map((url: unknown) => String(url)) : [],
      // The status word says something is wrong. The topic says what, which is
      // the difference between reading this and opening the account.
      policyTopics: (Array.isArray(adGroupAd.policySummary?.policyTopicEntries) ? adGroupAd.policySummary.policyTopicEntries : []).map((entry: Record<string, any>) => ({
        topic: String(entry?.topic ?? ""),
        type: String(entry?.type ?? ""),
      })),
      observations: observe(type, headlines, descriptions),
    };
  });

  // Across ads, not only inside one. Two ads in an ad group that share most of
  // their headlines are not two variants being tested against each other, and
  // nothing in the console says so at a glance.
  const byHeadline = new Map<string, { text: string; ads: Set<string>; adGroups: Set<string> }>();
  for (const ad of ads) {
    for (const headline of ad.headlines) {
      const key = headline.text.trim().toLowerCase();
      const found = byHeadline.get(key) ?? { text: headline.text, ads: new Set<string>(), adGroups: new Set<string>() };
      found.ads.add(ad.adId);
      found.adGroups.add(ad.adGroup);
      byHeadline.set(key, found);
    }
  }
  const duplicateHeadlines = [...byHeadline.values()]
    .filter((entry) => entry.ads.size > 1)
    .map((entry) => ({ text: entry.text, ads: [...entry.ads], adGroups: [...entry.adGroups] }))
    .sort((first, second) => second.ads.length - first.ads.length);

  const notes = [
    "Ad strength, approval status and the copy itself are the values now, not the values during any window. This tool reports no metrics, so there is no window for them to disagree with.",
    "Only a responsive search ad carries headlines and descriptions in these fields. Any other ad type is listed with its type and no copy rather than as an ad with nothing to say.",
    "Assets attached to the ad, campaign or account, such as sitelinks, promotions and prices, are not read here. An ad that looks thin in this output may still be serving with assets alongside it.",
  ];

  const lines: string[] = [`${ads.length} ad(s)${params.adGroup ? ` in ad group "${params.adGroup}"` : ""}`];
  for (const ad of ads) {
    lines.push(`- ${ad.adId} (${ad.campaign} / ${ad.adGroup}) ${ad.status}, strength ${ad.adStrength || "unknown"}, ${ad.approvalStatus || "unknown"}`);
    for (const headline of ad.headlines) lines.push(`    H: ${headline.text}${headline.pinned ? ` [pinned ${headline.pinned}]` : ""}${headline.performance ? ` (${headline.performance})` : ""}`);
    for (const description of ad.descriptions)
      lines.push(`    D: ${description.text}${description.pinned ? ` [pinned ${description.pinned}]` : ""}${description.performance ? ` (${description.performance})` : ""}`);
    if (ad.paths.length) lines.push(`    Path: /${ad.paths.join("/")}`);
    for (const topic of ad.policyTopics) lines.push(`    Policy: ${topic.topic}${topic.type ? ` (${topic.type})` : ""}`);
    for (const observation of ad.observations) lines.push(`    ${observation}`);
  }
  if (!ads.length) lines.push("No ads matched. With includeRemoved false, an ad group whose ads were all replaced reads as empty here.");
  if (duplicateHeadlines.length) {
    lines.push(`Headlines used by more than one ad:`);
    for (const duplicate of duplicateHeadlines) lines.push(`- "${duplicate.text}" in ${duplicate.ads.length} ads (${duplicate.adGroups.join(", ")})`);
  }
  lines.push(...notes);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { rowCount: ads.length, ads, duplicateHeadlines, notes },
  };
}
