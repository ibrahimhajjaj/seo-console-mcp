# Changelog

## 0.7.0

The remaining store surfaces, and quality data alongside acquisition data.

### Added

- `app_store_sales` reads Sales and Trends: units downloaded per day per
  territory per app, summarized by SKU. Needs a vendor number, which App Store
  Connect shows under Payments and Financial Reports. A period with no sales is
  reported as an absence rather than an error, since a quiet day should not look
  like a broken integration. Units come from a different pipeline than App
  Analytics and can differ from it, which the output says.
- `play_vitals` reads Android vitals from the Play Developer Reporting API:
  crash rate, ANR rate, error counts and startup metrics, daily or hourly. The
  window is clamped to the API's own reported freshness, because it refuses an
  end date past that and asking for today always fails. It carries no
  acquisition data, which the output also says.
- `play_store_stats` reads the reviews CSV and the store performance country
  breakdown, plus the cheaper `total_` variant.

## 0.6.0

Parity with what the consoles actually expose, and honest reporting of what they
do not.

### Added

- `crux_field_data` and `crux_history` read real-user Core Web Vitals from the
  Chrome UX Report, the second as a weekly series. Google is discontinuing
  PageSpeed's own field data, so field measurements move here while PageSpeed
  keeps the Lighthouse lab audits. An origin with too few anonymized samples
  reports `hasData: false` rather than zeros, and history periods with no samples
  keep their place as null so the series stays aligned with its periods.
- `app_store_reviews` reads customer reviews and developer responses. It reports
  the mean and star split of the reviews it fetched, never the app's rating:
  Apple's own OpenAPI specification has no aggregate rating resource, only age
  ratings.
- `app_store_discovery` reads the surfaces beyond the listing text, including
  Apple's indexed search keywords, which are held per locale. Each resource
  carries its own required filters, and one this key cannot serve is reported as
  unavailable rather than as empty.
- `app_store_listing` now also reports categories, age rating, phased release,
  release notes, and screenshot and preview sets per locale, naming any locale
  with no screenshots of its own since those fall back to another locale's.
- `play_store_stats` reads a date window across month boundaries, every install
  column rather than only the one it used, and the ratings and crashes report
  families. Store listing conversion rate and UTM attribution are surfaced, with
  the rate recomputed from grouped totals because averaging per-row rates would
  weight a quiet day like a busy one.
- `wporg_plugin` reads daily download history, the full five-to-one ratings
  histogram, the active version split, and the version requirements.
- `search_analytics` accepts the `discover` and `googleNews` result types and
  pages with `startRow`. Ranks continue across pages rather than restarting.

### Changed

- A superseded App Store version is no longer mistaken for a draft. Apple marks
  old versions REPLACED_WITH_NEW_VERSION, so defining "editable" as "not live"
  claimed a draft in preparation for every app that had ever shipped twice.
- `search_analytics` states that an exhausted page is still not proof of
  completeness, since Search Console returns top rows subject to its own limits.

## 0.5.0

Every tool now runs from the command line, and the server covers the other three
places a product gets discovered: the App Store, Google Play and WordPress.org.

### Added

- `query`: runs any tool from the shell and writes JSON to a file or stdout,
  exiting non-zero with the message on stderr. It runs the same implementation
  the MCP surface exposes, so the two cannot drift. A result that has to be
  compared six weeks later needs to be a file, and an MCP connection that drops
  mid-session must not silently stop recording history.
- `wporg_plugin`: WordPress.org install base, downloads, ratings and support
  stats by slug. Public API, no credentials. Flags a freshly published plugin,
  because the wp.org API under-reports one for a few days and a missing field
  there is not an absent field.
- `play_store_stats`: Google Play bulk reports: active device installs, and
  store-listing visitors, acquisitions and conversion rate by traffic source,
  search term and UTM campaign. Says outright whether any Play search traffic
  appears, since its absence is a finding rather than an error. Reports the last
  date actually present, because the reports lag by days.
- `app_store_listing`: App Store Connect listing per locale measured against
  Apple's limits (name 30, subtitle 30, keywords 100, promotional text 170).
  Apple indexes the name, subtitle and keyword field only, and drops a field one
  character over its limit silently rather than rejecting it. An app holds a live
  record and an editable one at once, so `state` selects which is read and the
  result says which it used.
- `snapshot`: every surface captured into one timestamped document, and
  `compare_snapshots`: the differences between two of them. Search Console
  totals come from the date dimension, never by summing queries, which
  undercounts because Google withholds low-volume rows. A surface that cannot be
  read is recorded in place rather than omitted, and a surface missing on either
  side is marked not comparable, so a collection failure is never read as a
  change. The comparison reports arithmetic and never whether a change was good
  or what caused it.
- The content and triage playbooks now reach the store surfaces and record a
  snapshot, so a later run can diff against today.

### Changed

- `search_analytics` now reports `truncated`. It asks Search Console for one row
  past the requested limit and never returns it, so a result that was cut off is
  distinguishable from one that happens to hold exactly `rowLimit` rows. A
  truncated list read as complete is how an absent query gets mistaken for
  absent demand.
- Write tools (`submit_sitemap`, `delete_sitemap`, `request_recrawl`,
  `indexnow_submit`) are marked `(write)` and refuse to run from the command
  line without `--allow-write`. Over MCP a person is watching the call; from a
  shell they are one line in a cron job.
- An unkeyed PageSpeed quota error now names `setup --pagespeed-key`.

## 0.4.0

Net-new keyword discovery from Google Autocomplete, with optional Search Console cross-reference.

### Added

- `keyword_ideas`: expands a seed through alphabet, question, preposition, and
  comparison families, then deduplicates the Google Autocomplete results. When
  `siteUrl` is passed, Search Console marks each idea as already ranking, with
  position, clicks, and impressions, or net-new. It needs no Google credentials
  unless `siteUrl` is passed and no extra API key.
- The `content_opportunities` and `seo_triage` prompts and the content and triage
  command playbooks now reference `keyword_ideas` for net-new topic discovery.

## 0.3.0

Bulk recrawl nudges for Google and IndexNow submission for the other engines.

### Added

- `request_recrawl`: checks URLs with the URL Inspection API and resubmits the
  covering sitemap when some are not indexed. Google exposes no request-indexing
  API, so a sitemap resubmission with fresh `lastmod` values is the supported bulk
  recrawl signal; the tool says so in its output and reports exactly which URLs are
  still pending. Takes explicit URLs or a sitemap; supports `dryRun`.
- `indexnow_submit`: submits up to 10,000 changed URLs per call to an IndexNow
  endpoint (Bing, Yandex, Naver, Seznam, Yep; Google does not participate). The key
  comes from `key` or `SEO_MCP_INDEXNOW_KEY` and must be hosted on the site as
  `https://<host>/<key>.txt`. Needs no Google credentials; supports `dryRun`.
  Neither the key nor its file location is ever echoed in tool output, since key
  file URLs conventionally contain the key.
- The `seo_triage` and `launch_seo_check` prompts now offer both tools when pages
  are not indexed.

## 0.2.2

### Changed

- The package now exposes a `seo-console-mcp` bin matching its name, alongside the
  existing `seo-mcp`. Both launch the same server.

## 0.2.1

### Fixed

- Credentials are now auto-discovered at the default location
  (`~/.config/seo-mcp/seo-mcp.key.json`, where `setup` writes the key) when no
  explicit `--credentials` / `SEO_MCP_CREDENTIALS` / `GOOGLE_APPLICATION_CREDENTIALS`
  is set, and an empty value is treated as unset. A standard install (including the
  Claude Code plugin) now works with no credentials configuration.

## 0.2.0

Search Console analysis, on-page auditing at scale, and guided workflows.

### Added

- Analysis tools that turn raw Search Console rows into decisions:
  - `search_opportunities`: striking-distance keywords (positions 5-20, high impressions).
  - `compare_search_periods`: gainers and losers versus the prior window.
  - `ctr_gaps`: pages/queries under-performing their position's CTR (rewrite targets); the expected CTR is calibrated from the property's own per-position data.
  - `query_cannibalization`: queries where multiple pages compete.
- `audit_site`: on-page audit of up to N pages from a sitemap, with a rollup of the most common issues.
- `index_coverage`: bulk indexing check across a sitemap (bounded to respect URL Inspection quota).
- `list_properties`: enumerate accessible Search Console properties.
- `delete_sitemap`: remove a submitted sitemap (supports `dryRun`).
- `search_analytics`: `dataState`, `aggregationType`, and `maxTableRows` (cap the text table; structured rows stay complete).
- `submit_sitemap`: `dryRun`.
- A `seo://properties` MCP resource (read live, never cached).
- MCP prompt playbooks: `seo_triage`, `content_opportunities`, `launch_seo_check`.
- Optional PageSpeed API key provisioning in `setup` (`--pagespeed-key` / `--no-pagespeed-key`); opt-in only.
- Output schemas on every tool (`registerTool`), a CI workflow, and coverage tooling.

### Changed

- Replaced the `googleapis` meta-package with the scoped `@googleapis/*` packages, cutting install size substantially.

### Fixed

- `seo_audit`: restrict the target and every redirect hop to public hosts and pin the connection to the validated address (DNS-rebinding safe); stream the body under the 10 MB cap; decode by the response charset.
- Setup wizard runs on Windows (gcloud spawn).
- CLI rejects unknown flags and honors `--help` before dispatching a subcommand.
- `verify` distinguishes real failures from retryable ones.
- `seo_audit` no longer miscounts SVG titles, empty `alt`, or cross-scheme internal links.

## 0.1.0

- Initial release: Google Search Console, PageSpeed Insights, and on-page SEO audit tools over MCP stdio, plus a `setup` wizard and Cloudflare-DNS `verify`.
