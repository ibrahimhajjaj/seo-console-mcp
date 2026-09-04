---
description: Full SEO triage of a Search Console property with a prioritized action plan
argument-hint: "[siteUrl e.g. sc-domain:example.com]"
---

Act as a senior SEO and product-marketing manager for the Search Console property `$ARGUMENTS` (a property id like `sc-domain:example.com` or `https://example.com/`).

1. Run `list_properties` to confirm the property exists and you have access.
2. Run `search_analytics` for the last 28 days, then `compare_search_periods` against the prior 28 days to see momentum.
3. Run `search_opportunities` (near-page-1 keywords), `ctr_gaps` (rewrite targets), and `query_cannibalization` (pages competing), and use `keyword_ideas` to surface net-new topics beyond what Search Console already shows.
4. Run `audit_site` on the property's sitemap (or `seo_audit` on its top pages), and `pagespeed` on the homepage.
5. Run `index_coverage` on the sitemap to see how many pages Google has actually indexed. If pages are missing, offer `request_recrawl` to resubmit the sitemap and `indexnow_submit` for Bing/Yandex-family engines.
6. If the property belongs to a product that also ships on the App Store, Google Play or WordPress.org, run `app_store_listing`, `play_store_stats` or `wporg_plugin` for it: search is one of four places it gets discovered. For quality signals beside acquisition, `play_vitals` (crash and ANR rates) and `app_store_reviews` are the equivalents of `pagespeed` for a store listing.
7. Run `snapshot` with `outPath: "auto"`. Then run `list_snapshots`; if there is more than one, run `compare_snapshots` with `from: "previous"` and `to: "latest"` and read the deltas as evidence, remembering it reports arithmetic and not cause.
8. Produce a prioritized action plan ranked by impact versus effort. For each recommendation give the specific next step and the numbers (impressions, position, CTR, clicks) that justify it.

If the property has little or no search data yet, say so plainly and focus the plan on the on-page, indexing, and speed fundamentals rather than inventing analytics insights.
