# Changelog

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
