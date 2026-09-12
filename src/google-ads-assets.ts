import type { z } from "zod";
import type { ToolResult } from "./google-tools.js";
import type { adsAssetsInput } from "./schemas.js";
import { quoteGaql, money, type AdsClient } from "./google-ads.js";

type Params = z.output<typeof adsAssetsInput>;

type Level = "account" | "campaign" | "adGroup";

interface AssetRow {
  assetId: string;
  type: string;
  level: Level;
  attachedTo: string;
  fieldType: string;
  status: string;
  summary: string;
}

// Google states a promotion percentage in millionths, where 1,000,000 is 100%.
// Printed raw it reads as a number nobody would recognise as a discount.
const percent = (value: unknown): number => Number(value ?? 0) / 10_000;

const cash = (amount: Record<string, any> | undefined): string => (amount ? `${money(amount.amountMicros).toFixed(2)} ${String(amount.currencyCode ?? "")}`.trim() : "");

// One line saying what the asset says. A type and an id answer that something is
// attached; they do not answer whether the promotion is the right promotion, or
// whether the sitelink still points at a page that exists.
function summarize(asset: Record<string, any>, fieldType: string): string {
  const type = String(asset.type ?? "");
  const finalUrl = Array.isArray(asset.finalUrls) && asset.finalUrls.length ? ` -> ${String(asset.finalUrls[0])}` : "";

  if (type === "SITELINK") {
    const sitelink = asset.sitelinkAsset ?? {};
    const descriptions = [sitelink.description1, sitelink.description2].map((part) => String(part ?? "")).filter(Boolean);
    return `"${String(sitelink.linkText ?? "")}"${descriptions.length ? `: ${descriptions.join(" / ")}` : ""}${finalUrl}`;
  }
  if (type === "CALLOUT") return `"${String(asset.calloutAsset?.calloutText ?? "")}"`;
  if (type === "STRUCTURED_SNIPPET") {
    const snippet = asset.structuredSnippetAsset ?? {};
    const values = Array.isArray(snippet.values) ? snippet.values.map((value: unknown) => String(value)) : [];
    return `${String(snippet.header ?? "")}: ${values.join(", ")}`;
  }
  if (type === "PROMOTION") {
    const promotion = asset.promotionAsset ?? {};
    const discount = promotion.percentOff ? `${percent(promotion.percentOff)}% off` : promotion.moneyAmountOff ? `${cash(promotion.moneyAmountOff)} off` : "discount not stated";
    const modifier = String(promotion.discountModifier ?? "") === "UP_TO" ? "up to " : "";
    const trigger = promotion.promotionCode ? ` with code ${String(promotion.promotionCode)}` : promotion.ordersOverAmount ? ` on orders over ${cash(promotion.ordersOverAmount)}` : "";
    const dates = [promotion.startDate, promotion.endDate].map((part) => String(part ?? "")).filter(Boolean);
    const occasion = String(promotion.occasion ?? "");
    return `${modifier}${discount} on ${String(promotion.promotionTarget ?? "")}${trigger}${occasion ? ` (${occasion})` : ""}${dates.length === 2 ? `, ${dates[0]} to ${dates[1]}` : ""}${finalUrl}`;
  }
  if (type === "PRICE") {
    const price = asset.priceAsset ?? {};
    const offerings = Array.isArray(price.priceOfferings) ? price.priceOfferings : [];
    const rendered = offerings.map((offering: Record<string, any>) =>
      `${String(offering?.header ?? "")} ${cash(offering?.price)}${offering?.unit ? ` per ${String(offering.unit).toLowerCase().replace(/^per_/, "").replace(/_/g, " ")}` : ""}`.trim(),
    );
    const qualifier = String(price.priceQualifier ?? "");
    return `${String(price.type ?? "")}${qualifier ? ` (${qualifier.toLowerCase()})` : ""}: ${rendered.join("; ")}`;
  }
  if (type === "CALL") return `${String(asset.callAsset?.countryCode ?? "")} ${String(asset.callAsset?.phoneNumber ?? "")}`.trim();
  if (type === "IMAGE") return String(asset.imageAsset?.fullSize?.url ?? asset.name ?? "");
  // Naming the type and stopping is honest. Inventing a summary for a shape this
  // tool does not read would be a sentence with nothing behind it.
  // Name the field type as well as the asset type: for an unshaped asset the
  // field type is usually the half that says what it is for, as with a TEXT
  // asset filed under BUSINESS_NAME.
  return `${[type || "asset", fieldType && fieldType !== type ? `filed as ${fieldType}` : "", String(asset.name ?? "")].filter(Boolean).join(" ")}, not read in detail by this tool`;
}

// A Money message cannot be selected whole: asset.promotion_asset.money_amount_off
// is rejected as an invalid argument, while its .amount_micros and .currency_code
// are fine. This is not a general rule about messages, since the repeated
// price_offerings below selects whole without complaint, so do not expand that
// one to match.
const ASSET_FIELDS = `asset.id, asset.type, asset.name, asset.final_urls,
   asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2,
   asset.callout_asset.callout_text,
   asset.structured_snippet_asset.header, asset.structured_snippet_asset.values,
   asset.promotion_asset.promotion_target, asset.promotion_asset.discount_modifier,
   asset.promotion_asset.percent_off,
   asset.promotion_asset.money_amount_off.amount_micros, asset.promotion_asset.money_amount_off.currency_code,
   asset.promotion_asset.promotion_code,
   asset.promotion_asset.orders_over_amount.amount_micros, asset.promotion_asset.orders_over_amount.currency_code,
   asset.promotion_asset.occasion, asset.promotion_asset.start_date, asset.promotion_asset.end_date,
   asset.price_asset.type, asset.price_asset.price_qualifier, asset.price_asset.price_offerings,
   asset.call_asset.phone_number, asset.call_asset.country_code,
   asset.image_asset.full_size.url`;

interface LevelSpec {
  level: Level;
  resource: string;
  link: string;
  owner: (row: Record<string, any>) => string;
  extraSelect: string;
  campaignFilter: boolean;
}

const LEVELS: LevelSpec[] = [
  { level: "account", resource: "customer_asset", link: "customerAsset", owner: () => "the whole account", extraSelect: "", campaignFilter: false },
  { level: "campaign", resource: "campaign_asset", link: "campaignAsset", owner: (row) => String(row.campaign?.name ?? ""), extraSelect: "campaign.name, ", campaignFilter: true },
  { level: "adGroup", resource: "ad_group_asset", link: "adGroupAsset", owner: (row) => String(row.adGroup?.name ?? ""), extraSelect: "ad_group.name, campaign.name, ", campaignFilter: true },
];

export async function adsAssets(api: AdsClient, params: Params): Promise<ToolResult> {
  // A name that matches nothing must not come back as a successful empty
  // answer. Without this, a typo returns zero rows beside a note saying
  // account-level assets are listed too, and the reader concludes the account
  // has none. Absence has to be told apart from a campaign that does not exist,
  // and the caller who mistypes a name is exactly the caller who will then say
  // "that campaign has no sitelinks" and act on it.
  if (params.campaign) {
    const found = await api.gaql(`SELECT campaign.name FROM campaign WHERE campaign.name = ${quoteGaql(params.campaign)}`);
    if (!found.length) {
      throw new Error(
        `No campaign named "${params.campaign}" exists in this account, so nothing was read. This is not the same as that campaign having no assets; check the name against ads_campaigns.`,
      );
    }
  }

  const assets: AssetRow[] = [];
  const levelErrors: Array<{ level: string; error: string }> = [];

  for (const spec of LEVELS) {
    const conditions: string[] = [];
    if (!params.includeRemoved) conditions.push(`${spec.resource}.status != 'REMOVED'`);
    if (params.type) conditions.push(`asset.type = '${params.type}'`);
    // An account-level asset is not scoped to a campaign, so a campaign filter
    // must not be applied to it. Dropping it instead would hide the assets most
    // likely to be serving beside an ad that appears to have none.
    if (params.campaign && spec.campaignFilter) conditions.push(`campaign.name = ${quoteGaql(params.campaign)}`);

    try {
      const rows = await api.gaql(
        `SELECT ${spec.extraSelect}${spec.resource}.field_type, ${spec.resource}.status, ${ASSET_FIELDS}
         FROM ${spec.resource}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`,
      );
      for (const row of rows) {
        const asset = (row.asset ?? {}) as Record<string, any>;
        const link = (row[spec.link] ?? {}) as Record<string, any>;
        assets.push({
          assetId: String(asset.id ?? ""),
          type: String(asset.type ?? ""),
          level: spec.level,
          attachedTo: spec.owner(row),
          fieldType: String(link.fieldType ?? ""),
          status: String(link.status ?? ""),
          summary: summarize(asset, String(link.fieldType ?? "")),
        });
      }
    } catch (error) {
      // One level failing must not take the other two with it. An empty list
      // that silently meant "the query broke" would read as "nothing attached",
      // which is the wrong answer to the only question this tool is asked.
      levelErrors.push({ level: spec.level, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const byType: Record<string, number> = {};
  for (const asset of assets) byType[asset.type] = (byType[asset.type] ?? 0) + 1;

  const notes = [
    "An account-level asset applies to every campaign, so it is listed even when a campaign is named. An ad with no assets of its own can still serve with these beside it.",
    "Attached is not shown. Google decides per auction whether to show an asset and which ones, so this says what is available to serve, not what served.",
    "This reports no metrics, so nothing here is of a window. For what an asset earned, the account's asset reporting is a separate read this tool does not do.",
  ];
  if (levelErrors.length) notes.push("One or more levels could not be read and are listed in levelErrors. Treat the asset list as incomplete rather than as the whole picture.");

  const lines: string[] = [`${assets.length} asset link(s)${params.campaign ? ` for campaign "${params.campaign}" and the account` : ""}${params.type ? ` of type ${params.type}` : ""}`];
  for (const level of ["account", "campaign", "adGroup"] as const) {
    const forLevel = assets.filter((asset) => asset.level === level);
    if (!forLevel.length) continue;
    lines.push(`${level}:`);
    for (const asset of forLevel) {
      // fieldType usually repeats type exactly, so showing it every time is
      // noise. Shown only when it differs, which is when it carries something.
      const slot = asset.fieldType && asset.fieldType !== asset.type ? ` filed as ${asset.fieldType}` : "";
      lines.push(`- ${asset.type}${slot} on ${asset.attachedTo} (${asset.status || "status unknown"}): ${asset.summary}`);
    }
  }
  if (!assets.length && !levelErrors.length) {
    lines.push("Nothing is attached at any level. Sitelinks, callouts and the rest are what fill the space under an ad, so an account with none is showing the ad text alone.");
  }
  for (const failure of levelErrors) lines.push(`Could not read ${failure.level} assets: ${failure.error}`);
  lines.push(...notes);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { rowCount: assets.length, assets, byType, levelErrors, notes },
    ...(levelErrors.length ? { isError: true } : {}),
  };
}
