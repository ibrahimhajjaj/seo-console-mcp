# Changelog

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
