# seo-mcp

`seo-mcp` is a stdio [Model Context Protocol](https://modelcontextprotocol.io/) server for Google Search Console, PageSpeed Insights, and on-page SEO audits. It gives MCP clients thirty-six tools covering verified Search Console properties and the other places products get discovered, the App Store, Google Play, WordPress.org, Google Ads, and real-user Core Web Vitals, while keeping the HTML audit, PageSpeed, IndexNow, keyword ideas, and WordPress.org tools usable without Google service account credentials. Every tool also runs from the command line, so a result can be written to a file instead of into a model's context, and `snapshot` records Search Console, the App Store, Google Play and WordPress.org at one moment so a later run can diff against it.

## Requirements

- Node.js 20.18.1 or newer
- `gcloud` only if you use the setup wizard

What else you need depends on which tools you use. The setup wizard covers Search Console and PageSpeed; the App Store, Google Play, and Chrome UX Report tools each need a credential you create yourself.

| Tools | Needs | Where it comes from |
|---|---|---|
| `seo_audit`, `audit_site`, `keyword_ideas` (without `siteUrl`), `wporg_plugin` | nothing | public endpoints |
| `pagespeed` | optional `SEO_MCP_PAGESPEED_KEY` | setup wizard `--pagespeed-key`, or a Google Cloud API key |
| `crux_field_data`, `crux_history` | `SEO_MCP_CRUX_KEY` (or the PageSpeed key if it may call the CrUX API) | Google Cloud API key |
| `indexnow_submit` | `SEO_MCP_INDEXNOW_KEY` | any key you host at `/<key>.txt` |
| Search Console tools, `snapshot` properties | service account key | setup wizard, then add the account to the property |
| `snapshot`, `list_snapshots`, `compare_snapshots` | optional `SEO_MCP_SNAPSHOT_DIR` | where snapshot files live, defaulting to `~/.config/seo-mcp/snapshots` |
| `verify` | `CLOUDFLARE_API_TOKEN` | Cloudflare, Zone.DNS:Edit |
| `app_store_listing`, `app_store_discovery`, `app_store_reviews` | `SEO_MCP_ASC_KEY_PATH`, `SEO_MCP_ASC_KEY_ID`, `SEO_MCP_ASC_ISSUER_ID` | App Store Connect team key, any role that can read the app |
| `app_store_sales` | the above plus `SEO_MCP_ASC_VENDOR_NUMBER` | team key created with Admin, Finance, or Sales and Reports |
| `play_store_stats` | `SEO_MCP_PLAY_BUCKET`, `SEO_MCP_PLAY_CREDENTIALS` | service account with read access to the reporting bucket |
| `play_vitals` | `SEO_MCP_PLAY_CREDENTIALS` | service account invited in Play Console with app quality access |
| the `ads_` tools | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | a Google Ads developer token and an OAuth client with a refresh token |

## Install and build

```sh
npm install
npm run build
```

Run the local server with:

```sh
node /absolute/path/to/seo-mcp/dist/index.js
```

The package is published on npm as `seo-console-mcp`; it installs a command named `seo-mcp`. An MCP client can launch it through:

```sh
npx -y seo-console-mcp
```

The running server uses stdout exclusively for the MCP wire protocol. Diagnostics are written to stderr.

## Setup wizard

From a local checkout:

```sh
npm run setup
```

Or with `npx`:

```sh
npx -y seo-console-mcp setup
```

For an unattended project choice or a custom key location:

```sh
seo-mcp setup --project my-seo-project --key /absolute/path/seo-mcp.key.json
```

The wizard also offers an optional PageSpeed Insights API key for higher quota. It is opt-in: use `--pagespeed-key` to create one without a prompt, or `--no-pagespeed-key` to skip the prompt explicitly. Non-interactive runs skip it unless `--pagespeed-key` is provided.

The wizard is safe to rerun. It:

1. Checks for `gcloud`. If it is absent, it prints manual instructions and exits successfully without changing anything.
2. Uses the active authenticated account or runs `gcloud auth login`.
3. Uses the current project, a supplied `--project`, or asks for a project ID. It creates the project if it does not exist and selects it.
4. Enables `searchconsole.googleapis.com`, `pagespeedonline.googleapis.com`, and `siteverification.googleapis.com`.
5. Reuses or creates the `seo-mcp` service account.
6. Reuses an existing key or creates `seo-mcp.key.json`.
7. Optionally creates a project-scoped API key restricted to PageSpeed Insights.
8. Prints the required Search Console permission step and ready-to-copy client configurations.

The wizard never prints the service account key contents. When PageSpeed key creation is requested and succeeds, it prints that key once in the final client configuration. The generated `*.key.json` filename is ignored by Git.

### Granting the service account Search Console access

The Search Console API has no endpoint for adding a user to a property, so the service account has to become a verified owner of the domain itself. There are two ways to do that.

#### Automated (Cloudflare DNS)

If the domain's DNS is on Cloudflare, `verify` does the whole thing: it asks Google for a verification token, writes the TXT record through the Cloudflare API, waits for verification, and registers the property.

```sh
export CLOUDFLARE_API_TOKEN=...   # a token scoped to Zone.DNS:Edit for the zone
seo-mcp verify getpsst.app another-domain.com
```

The token can also be passed with `--cf-token`, and the key path with `--credentials` (otherwise `GOOGLE_APPLICATION_CREDENTIALS` / `SEO_MCP_CREDENTIALS` is used). The command is idempotent: the TXT record is left in place (Google re-checks it), so re-running a domain is safe. Leave the record in DNS or ownership is lost.

`verify` reads the token from `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN` (or `--cf-token`) and never stores or logs it, so any secret store that can export an environment variable works. The token needs `Zone -> DNS -> Edit` and `Zone -> Zone -> Read` (the "Edit zone DNS" template), scoped to the zones you verify. To keep it out of shell history:

macOS (Keychain):

```sh
security add-generic-password -a "$USER" -s cloudflare-dns-edit -l "Cloudflare DNS Edit" -U -w   # store once, hidden prompt
CLOUDFLARE_API_TOKEN=$(security find-generic-password -s cloudflare-dns-edit -w) seo-mcp verify example.com
```

Linux (libsecret, or `pass`):

```sh
secret-tool store --label="Cloudflare DNS Edit" service cloudflare-dns-edit   # store once, hidden prompt
CLOUDFLARE_API_TOKEN=$(secret-tool lookup service cloudflare-dns-edit) seo-mcp verify example.com
```

Windows (PowerShell SecretManagement):

```powershell
Set-Secret -Name cloudflare-dns-edit -Secret (Read-Host -AsSecureString)   # store once, hidden prompt
$env:CLOUDFLARE_API_TOKEN = Get-Secret -Name cloudflare-dns-edit -AsPlainText; seo-mcp verify example.com
```

#### Manual

Add the service account as an owner in the Search Console UI:

```text
Search Console -> your property -> Settings -> Users and permissions -> Add user
  seo-mcp@PROJECT_ID.iam.gserviceaccount.com  ->  Owner
```

Use the exact service account email printed by the wizard. Owner access is needed because `submit_sitemap` is a write operation.

### Manual Google Cloud fallback

If `gcloud` is unavailable, create the credentials manually or run these commands after installing it:

```sh
gcloud auth login
gcloud projects create YOUR_PROJECT_ID
gcloud config set project YOUR_PROJECT_ID
gcloud services enable searchconsole.googleapis.com pagespeedonline.googleapis.com siteverification.googleapis.com
gcloud iam service-accounts create seo-mcp --display-name="SEO MCP"
gcloud iam service-accounts keys create ./seo-mcp.key.json \
  --iam-account=seo-mcp@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

If the project already exists, skip `gcloud projects create`. Then grant the service account Search Console access (see above) and configure the absolute key path in the MCP client.

## Authentication

The Search Console tools use `google.auth.GoogleAuth` with both scopes:

- `https://www.googleapis.com/auth/webmasters`
- `https://www.googleapis.com/auth/webmasters.readonly`

Credential lookup order is:

1. `--credentials /absolute/path/key.json`
2. `SEO_MCP_CREDENTIALS`
3. `GOOGLE_APPLICATION_CREDENTIALS`
4. `~/.config/seo-mcp/seo-mcp.key.json` (or `$XDG_CONFIG_HOME/seo-mcp/...`) if it exists. This is the default location the setup wizard writes to, so a standard install needs no configuration.

For example:

```sh
node dist/index.js --credentials /absolute/path/seo-mcp.key.json
```

`pagespeed` is public and does not use the service account. Set `SEO_MCP_PAGESPEED_KEY` or pass `apiKey` to that tool for a higher PageSpeed Insights quota. `seo_audit`, `audit_site`, and `indexnow_submit` also need no Google credentials; `indexnow_submit` instead takes an IndexNow key via `key` or `SEO_MCP_INDEXNOW_KEY`. `keyword_ideas` only needs them when `siteUrl` is passed for the Search Console cross-reference. App Store Sales and Trends reads `SEO_MCP_ASC_VENDOR_NUMBER`. The Chrome UX Report tools read `SEO_MCP_CRUX_KEY`, falling back to `SEO_MCP_PAGESPEED_KEY` when the same key is allowed to call `chromeuxreport.googleapis.com`. `snapshot`, `list_snapshots` and `compare_snapshots` keep their documents in `SEO_MCP_SNAPSHOT_DIR`, defaulting to `~/.config/seo-mcp/snapshots`, and cannot read or write outside it. The table under Requirements maps every tool to what it needs.

## Security model

- Verifying a domain makes the service account a **verified Owner**. Owners can change Search Console settings and submit removal (deindex) requests, so treat the key as a sensitive credential even though most tools here only read.
- **Keep the key local.** It lives at the `GOOGLE_APPLICATION_CREDENTIALS` path (`chmod 600` recommended). Never bundle it in a published package, a container image, or a CI secret store. If it leaks, anyone with it has owner control of every verified property.
- **Leave the `google-site-verification` TXT record in DNS.** Google re-checks it; deleting it revokes ownership.
- **No secret is logged.** The wizard and `verify` print credential paths only, never key or token contents.
- **Revoking is easy.** Relinquish ownership from the Search Console UI (or `siteVerification.webResource.delete`), and rotate the key with `gcloud iam service-accounts keys delete`.
- **`seo_audit` only fetches public hosts.** The target URL and every redirect hop is resolved and refused if it lands on a loopback, private, link-local, or other non-public address, so a model cannot be steered into fetching internal services or cloud metadata. The address is validated again at connection time (the socket is pinned to the validated address), so a DNS-rebinding host cannot present a public address at validation and a private one at connect. Set `SEO_MCP_ALLOW_PRIVATE_HOSTS=1` to audit internal or staging hosts you trust. This is not a substitute for network-level isolation; run the server behind egress controls if you audit untrusted URLs on a host with reachable internal services.

## Claude Code plugin

This repo is also a Claude Code plugin that bundles the MCP server and adds three
slash commands over it. From Claude Code:

```text
/plugin marketplace add ibrahimhajjaj/seo-console-mcp
/plugin install seo-console@verdelic
```

It registers the MCP server (via `npx -y seo-console-mcp`) and adds:

- `/seo-console:triage <siteUrl>`: full property triage with a prioritized action plan
- `/seo-console:content <siteUrl>`: content to create or improve, backed by Search Console data
- `/seo-console:launch <siteUrl>`: pre-launch / launch SEO readiness check

The server finds your service-account key automatically at the default location
(`~/.config/seo-mcp/seo-mcp.key.json`, where the setup wizard writes it), so no
configuration is needed for a standard install. For a key elsewhere, set
`GOOGLE_APPLICATION_CREDENTIALS` (and `SEO_MCP_PAGESPEED_KEY` for higher PageSpeed
quota) in the environment Claude Code runs in. The `seo_audit` and `pagespeed`
tools work with no credentials at all.

To try it from a local checkout without a marketplace: `claude --plugin-dir .`.

## Claude Code (MCP server only)

Register the local build for the current user:

```sh
claude mcp add --scope user seo-mcp --env GOOGLE_APPLICATION_CREDENTIALS=/abs/path/seo-mcp.key.json -- node /abs/path/seo-mcp/dist/index.js
```

The `--` separator is mandatory. It separates Claude Code options from the MCP server command.

Or with `npx` (no local build):

```sh
claude mcp add --scope user seo-mcp --env GOOGLE_APPLICATION_CREDENTIALS=/abs/path/seo-mcp.key.json -- npx -y seo-console-mcp
```

User scope makes the server available across your projects. Use `--scope project` when the registration should be shared through the current project's `.mcp.json` instead.

Project `.mcp.json`:

```json
{
  "mcpServers": {
    "seo-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/seo-mcp/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/abs/path/seo-mcp.key.json"
      }
    }
  }
}
```

## Claude Desktop

Add the same server entry under `mcpServers` in Claude Desktop's configuration file, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "seo-mcp": {
      "command": "node",
      "args": ["/abs/path/seo-mcp/dist/index.js"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/abs/path/seo-mcp.key.json"
      }
    }
  }
}
```

To run without a local build, use `"command": "npx"` and `"args": ["-y", "seo-console-mcp"]`.

## Resources

`seo://properties` returns the Google Search Console properties available to the service account as JSON. It calls Search Console on every read, so the result is always current.

## Prompts

MCP clients surface these prompts as starting points a user can pick for common SEO workflows:

- `seo_triage` confirms a property, analyzes recent performance and opportunities, audits the site, and produces an impact-versus-effort action plan.
- `content_opportunities` groups evidence-backed recommendations into content to create and existing content to improve.
- `launch_seo_check` produces a go/no-go checklist for technical and indexing readiness before launch.

## Tools

Every tool validates its input with Zod. Tool failures return an MCP error result instead of terminating the server. Google API status, message, and reason are included when available. A Search Console 403 also explains how to grant the service account property access.

### `list_properties`

Lists every Google Search Console property the service account can access, returning each property's exact `siteUrl` and `permissionLevel`. It takes no input. Service-account credentials are required, unlike `pagespeed`, `seo_audit`, `audit_site`, and `indexnow_submit`.

<!-- params:list_properties -->

This tool takes no parameters.

<!-- /params:list_properties -->

### `search_analytics`

Queries `searchanalytics.query` and returns a compact ranked table plus structured rows.

```json
{
  "siteUrl": "sc-domain:example.com",
  "startDate": "2026-06-01",
  "endDate": "2026-06-28",
  "dimensions": ["query", "page"],
  "rowLimit": 100,
  "maxTableRows": 25,
  "dimensionFilterGroups": [
    {
      "groupType": "and",
      "filters": [
        { "dimension": "query", "operator": "contains", "expression": "seo" }
      ]
    }
  ],
  "type": "web"
}
```

<!-- params:search_analytics -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property, such as https://example.com/ or sc-domain:example.com |
| `startDate` | string | no |  | Start date in YYYY-MM-DD; defaults to 28 days ago |
| `endDate` | string | no |  | End date in YYYY-MM-DD; defaults to today |
| `dimensions` | list of one of query, page, country, device, date, searchAppearance | no | `["query"]` | Dimensions used to group results |
| `rowLimit` | number | no | `25` | Maximum rows to return |
| `startRow` | number | no | `0` | Zero-based row to start from, for paging through a large result |
| `maxTableRows` | number | no | `25` | Cap rows shown in the text table; structured rows are always complete. 0 = summary only. |
| `dimensionFilterGroups` | JSON list | no |  | Search Console dimension filters |
| `type` | one of web, image, video, news, discover, googleNews | no |  | Result type. discover is the Discover feed and googleNews is the Google News app and news.google.com, not the News tab in Search. Both support fewer dimensions than web: neither reports a query dimension |
| `dataState` | one of full, all | no |  | full = finalized data (default, ~2-3 day lag); all = include recent partial data |
| `aggregationType` | one of auto, byProperty, byPage | no |  | How Search Console aggregates rows |

<!-- /params:search_analytics -->

`maxTableRows` caps only the text table; the structured rows stay complete, so 0 returns the totals with no table rather than an empty result. `discover` and `googleNews` support fewer dimensions than `web`: neither reports a `query` dimension.

### `keyword_ideas`

Expands a seed through Google Autocomplete and returns normalized, deduplicated keyword ideas grouped by discovery family. It uses the public autocomplete endpoint, needs no extra API key, and works without Google credentials unless `siteUrl` is provided. With a Search Console property, it labels ideas already ranking with their average position, clicks, and impressions over the selected lookback window.

```json
{
  "seed": "technical seo",
  "siteUrl": "sc-domain:example.com",
  "language": "en",
  "country": "us",
  "expansions": ["alphabet", "questions", "prepositions", "comparisons"],
  "days": 90,
  "limit": 100
}
```

<!-- params:keyword_ideas -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `seed` | string | yes |  | Seed keyword to expand |
| `siteUrl` | string | no |  | Optional Search Console property used to identify queries already ranking |
| `language` | string | no | `"en"` | Autocomplete interface language passed as hl |
| `country` | string | no |  | Autocomplete country passed as gl |
| `expansions` | list of one of alphabet, questions, prepositions, comparisons | no | `["alphabet","questions","prepositions","comparisons"]` | Suggestion expansion families to run beyond the bare seed |
| `days` | number | no | `90` | Search Console lookback window in days |
| `limit` | number | no | `100` | Maximum keyword ideas to return |

<!-- /params:keyword_ideas -->

All four expansion families run by default. `days` defaults to 90 and is capped at 480; `limit` defaults to 100 and is capped at 500. Individual autocomplete failures are counted without discarding successful suggestions.

### `search_opportunities`

Finds high-impression queries in striking distance of stronger rankings. It groups by query and page, defaults to positions 5 through 20, and returns opportunities ranked by impression-weighted position.

```json
{
  "siteUrl": "sc-domain:example.com",
  "startDate": "2026-06-01",
  "endDate": "2026-06-28",
  "minPosition": 5,
  "maxPosition": 20,
  "minImpressions": 100,
  "limit": 25
}
```

<!-- params:search_opportunities -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property to analyze |
| `startDate` | string | no |  | Start date in YYYY-MM-DD; defaults to the latest 28-day window |
| `endDate` | string | no |  | End date in YYYY-MM-DD; defaults to today |
| `minPosition` | number | no |  | Lowest average position to include; defaults to 5 |
| `maxPosition` | number | no |  | Highest average position to include; defaults to 20 |
| `minImpressions` | number | no |  | Minimum impressions required; defaults to 10 |
| `limit` | number | no |  | Maximum opportunities to return; defaults to 50 |

<!-- /params:search_opportunities -->

### `compare_search_periods`

Compares a selected window with the immediately preceding equal-length window. It returns the largest click gainers and losers grouped by query or page.

```json
{
  "siteUrl": "sc-domain:example.com",
  "startDate": "2026-06-01",
  "endDate": "2026-06-28",
  "by": "query",
  "limit": 25
}
```

<!-- params:compare_search_periods -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property to analyze |
| `startDate` | string | no |  | Start date in YYYY-MM-DD; defaults to the latest 28-day window |
| `endDate` | string | no |  | End date in YYYY-MM-DD; defaults to today |
| `by` | one of query, page | no | `"query"` | Dimension used to compare performance |
| `limit` | number | no |  | Maximum gainers and losers to return; defaults to 50 each |

<!-- /params:compare_search_periods -->

### `ctr_gaps`

Finds high-impression queries or pages whose CTR trails the average for rows at the same rounded position. The missed-click estimate helps prioritize title and description rewrites.

```json
{
  "siteUrl": "sc-domain:example.com",
  "by": "page",
  "minImpressions": 250,
  "limit": 25
}
```

<!-- params:ctr_gaps -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property to analyze |
| `startDate` | string | no |  | Start date in YYYY-MM-DD; defaults to the latest 28-day window |
| `endDate` | string | no |  | End date in YYYY-MM-DD; defaults to today |
| `by` | one of query, page | no | `"query"` | Dimension used to identify CTR gaps |
| `minImpressions` | number | no |  | Minimum impressions required; defaults to 100 |
| `limit` | number | no |  | Maximum gaps to return; defaults to 50 |

<!-- /params:ctr_gaps -->

### `query_cannibalization`

Finds queries for which multiple pages receive Search Console impressions. Results group the competing pages and rank groups by total impressions.

```json
{
  "siteUrl": "sc-domain:example.com",
  "startDate": "2026-06-01",
  "endDate": "2026-06-28",
  "minImpressions": 25
}
```

<!-- params:query_cannibalization -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property to analyze |
| `startDate` | string | no |  | Start date in YYYY-MM-DD; defaults to the latest 28-day window |
| `endDate` | string | no |  | End date in YYYY-MM-DD; defaults to today |
| `minImpressions` | number | no |  | Minimum impressions per query-page row; defaults to 10 |

<!-- /params:query_cannibalization -->

### `list_sitemaps`

Lists sitemap path, submission/download times, pending/index flags, warning/error counts, and content counts.

```json
{
  "siteUrl": "https://www.example.com/"
}
```

<!-- params:list_sitemaps -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property |

<!-- /params:list_sitemaps -->

### `submit_sitemap`

Submits a sitemap and refreshes its current state. This is a write operation. If submission succeeds but the state refresh fails, the result still confirms that Google accepted the write and reports the refresh warning.

```json
{
  "siteUrl": "sc-domain:example.com",
  "feedpath": "https://www.example.com/sitemap.xml"
}
```

<!-- params:submit_sitemap -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property |
| `feedpath` | string | yes |  | Absolute URL of the sitemap to submit |
| `dryRun` | boolean | no | `false` | If true, report what would be submitted without writing to Search Console |

<!-- /params:submit_sitemap -->

### `delete_sitemap`

Removes a submitted sitemap from a Search Console property. This is a write operation. Set `dryRun` to `true` to preview the removal without changing Search Console.

```json
{
  "siteUrl": "sc-domain:example.com",
  "feedpath": "https://www.example.com/sitemap.xml",
  "dryRun": true
}
```

<!-- params:delete_sitemap -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property |
| `feedpath` | string | yes |  | Absolute URL of the sitemap to remove |
| `dryRun` | boolean | no | `false` | If true, report what would be removed without writing to Search Console |

<!-- /params:delete_sitemap -->

### `inspect_url`

Returns index coverage, verdict, robots state, indexing state, crawl time, fetch state, Google and user canonicals, mobile usability, and rich-result status.

```json
{
  "siteUrl": "sc-domain:example.com",
  "inspectionUrl": "https://www.example.com/products/widget"
}
```

<!-- params:inspect_url -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property containing the inspected URL |
| `inspectionUrl` | string | yes |  | Fully qualified URL to inspect |

<!-- /params:inspect_url -->

### `index_coverage`

Fetches a sitemap and checks a bounded set of its direct page URLs with Google's URL Inspection API. It returns indexed, not-indexed, and failed counts, the not-indexed URLs and coverage states, full per-URL results, and whether the result was truncated. Sitemap indexes are not followed into child sitemaps.

```json
{
  "siteUrl": "sc-domain:example.com",
  "sitemapUrl": "https://www.example.com/sitemap.xml",
  "maxUrls": 20,
  "concurrency": 3
}
```

<!-- params:index_coverage -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property containing the sitemap URLs |
| `sitemapUrl` | string | yes |  | Fully qualified sitemap URL to inspect |
| `maxUrls` | number | no | `20` | Maximum URLs to inspect |
| `concurrency` | number | no | `3` | Concurrent URL Inspection requests |

<!-- /params:index_coverage -->

`maxUrls` defaults to 20 and has a hard maximum of 50. `concurrency` defaults to 3 and has a hard maximum of 5. These limits protect the URL Inspection API quota, which is approximately 2,000 queries per day and 600 per minute for each property.

### `request_recrawl`

Checks URLs with the URL Inspection API and, when some are not indexed, resubmits the covering sitemap. That resubmission is Google's only supported bulk recrawl signal: there is no request-indexing API, and the Search Console UI's Request Indexing button has no programmatic equivalent. URLs come from `urls` or are read from `sitemapUrl`; the sitemap to resubmit is `feedpath`, defaulting to `sitemapUrl`. This is a write operation. Set `dryRun` to `true` to inspect and report without resubmitting.

```json
{
  "siteUrl": "sc-domain:example.com",
  "sitemapUrl": "https://www.example.com/sitemap.xml",
  "maxUrls": 20,
  "dryRun": true
}
```

<!-- params:request_recrawl -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `siteUrl` | string | yes |  | Search Console property containing the URLs |
| `urls` | list of string | no |  | Explicit URLs to check; omit to read them from sitemapUrl |
| `sitemapUrl` | string | no |  | Sitemap to read URLs from; also the default sitemap to resubmit |
| `feedpath` | string | no |  | Sitemap to resubmit when unindexed URLs are found; defaults to sitemapUrl |
| `maxUrls` | number | no | `20` | Maximum sitemap URLs to inspect |
| `concurrency` | number | no | `3` | Concurrent URL Inspection requests |
| `dryRun` | boolean | no | `false` | If true, inspect and report without resubmitting the sitemap |

<!-- /params:request_recrawl -->

It shares the `index_coverage` caps (`maxUrls` up to 50, `concurrency` up to 5) because both draw on the same URL Inspection quota. Resubmission only prompts a recrawl of pages whose sitemap `lastmod` is fresh, so keep `lastmod` accurate for changed URLs.

### `indexnow_submit`

Submits up to 10,000 changed URLs in one call to an [IndexNow](https://www.indexnow.org/) endpoint. Participating engines (Bing, Yandex, Naver, Seznam, Yep) share submissions with each other. Google does not use IndexNow; use `request_recrawl` for Google. This is a write operation and supports `dryRun`. It needs no Google credentials.

```json
{
  "urls": ["https://www.example.com/new-page", "https://www.example.com/updated-page"],
  "key": "your-indexnow-key"
}
```

<!-- params:indexnow_submit -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `urls` | list of string | yes |  | Changed page URLs; one submission covers one host |
| `key` | string | no |  | IndexNow key; defaults to SEO_MCP_INDEXNOW_KEY. The same key must be hosted on the site as a text file at https://<host>/<key>.txt (or at keyLocation) containing only the key |
| `keyLocation` | string | no |  | URL of the hosted key file when it is not https://<host>/<key>.txt |
| `endpoint` | one of api.indexnow.org, www.bing.com, yandex.com, searchadvisor.naver.com, search.seznam.cz, indexnow.yep.com | no | `"api.indexnow.org"` | IndexNow endpoint to notify; participating engines share submissions |
| `dryRun` | boolean | no | `false` | If true, report what would be submitted without notifying the endpoint |

<!-- /params:indexnow_submit -->

All URLs in one submission must share one host. The key is any 8-128 character value of letters, digits, or dashes, passed as `key` or `SEO_MCP_INDEXNOW_KEY`, and must be hosted as a text file containing exactly the key at `https://<host>/<key>.txt` (or at `keyLocation` on the same host). Because key file URLs conventionally contain the key, neither the key nor `keyLocation` is ever echoed in tool output. `endpoint` defaults to `api.indexnow.org`; a submission to any participating endpoint reaches all of them.

### `pagespeed`

Returns CrUX field data when available, including LCP, CLS, INP or FID, FCP, and TTFB. It also returns Lighthouse category scores and up to ten highest-savings opportunities.

```json
{
  "url": "https://www.example.com/",
  "strategy": "mobile",
  "category": ["performance", "seo", "accessibility", "best-practices"]
}
```

<!-- params:pagespeed -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes |  | Public page URL to analyze |
| `strategy` | one of mobile, desktop | no | `"mobile"` | Lighthouse device strategy |
| `category` | list of one of performance, seo, accessibility, best-practices | no | `["performance","seo","accessibility","best-practices"]` | Lighthouse categories to run |
| `apiKey` | string | no |  | Optional PageSpeed Insights API key; defaults to SEO_MCP_PAGESPEED_KEY |

<!-- /params:pagespeed -->

`strategy` defaults to `mobile`. All four categories are requested by default. `apiKey` is optional and overrides `SEO_MCP_PAGESPEED_KEY` for that call.

### `seo_audit`

Fetches up to 10 MB of HTML with redirects enabled, a 15-second timeout, and an identifying user agent. It extracts title and description lengths, canonical, robots, H1s and heading outline, Open Graph and Twitter tags, JSON-LD types, image alt coverage, internal/external links, word count, language, and viewport. It flags missing or duplicate titles, a missing description, missing or multiple H1s, a missing canonical, and missing or invalid JSON-LD.

```json
{
  "url": "https://www.example.com/landing-page"
}
```

<!-- params:seo_audit -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes |  | Public page URL to audit |

<!-- /params:seo_audit -->

### `audit_site`

Fetches a sitemap and audits up to 50 of its page URLs with bounded concurrency. Sitemap indexes are supported with a hard cap of five child sitemap fetches. The result includes compact per-page findings, isolated page-fetch errors, a count of each shared issue, and explicit truncation and skipped counts. It does not require Google credentials.

```json
{
  "sitemapUrl": "https://www.example.com/sitemap.xml",
  "maxPages": 20,
  "concurrency": 5
}
```

<!-- params:audit_site -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sitemapUrl` | string | yes |  | Public sitemap URL to audit |
| `maxPages` | number | no | `20` | Maximum pages to audit |
| `concurrency` | number | no | `5` | Maximum page fetches in flight |

<!-- /params:audit_site -->

`maxPages` defaults to 20 and `concurrency` defaults to 5. Their maximum values are 50 and 10, respectively.

### `wporg_plugin`

Looks up a WordPress.org plugin by slug and returns active installs, downloads, ratings, support threads, and version dates. It uses the public wp.org API and needs no credentials or API key. A plugin published within the last few days is reported with `possiblyLagging: true` when a field looks empty, because the wp.org API under-reports fresh plugins; the field may be live on the page already.

```json
{ "slug": "akismet" }
```

<!-- params:wporg_plugin -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `slug` | string | yes |  | WordPress.org plugin slug, e.g. akismet |
| `downloadDays` | number | no | `30` | Days of daily download history to fetch; 0 skips it |
| `includeVersionDistribution` | boolean | no | `true` | Also fetch the share of active installs on each plugin version |

<!-- /params:wporg_plugin -->

### `play_store_stats`

Reads the Google Play bulk reports for an app and returns Active Device Installs, plus store-listing visitors and acquisitions grouped by traffic source and search term. `hasPlaySearchRows` states outright whether any Play search traffic appears, since its absence is a finding rather than an error. Reports lag by days, so `lastDatePresent` is the last date actually in the files rather than today.

```json
{ "packageName": "com.example.app", "month": "202608" }
```

<!-- params:play_store_stats -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `packageName` | string | yes |  | Android package name, e.g. app.getpsst |
| `month` | string | no |  | Report month as YYYYMM; defaults to the current UTC month. Ignored when startDate and endDate are given |
| `installsDimension` | one of overview, country, language, device, os_version, carrier, app_version | no | `"overview"` | Which installs report to read. overview is undocumented by Google but present in real buckets; the others are the documented breakdowns |
| `include` | list of one of ratings, crashes, reviews | no | `[]` | Extra report families to read. Missing files are normal: Google emits a report only when there is something to report |
| `storePerformanceDimension` | one of traffic_source, country | no | `"traffic_source"` | Which store performance breakdown to read |
| `storePerformanceTotals` | boolean | no | `false` | Read the total_ variant instead. It is a different report, not a rollup of the same one: it carries acquisitions only, with no visitors and no conversion rate, and for some apps it covers far fewer dates and attributes every acquisition to a placeholder source |
| `ratingsDimension` | one of country, language, device, os_version, carrier, app_version | no | `"country"` | Dimension for the ratings report |
| `crashesDimension` | one of device, os_version, app_version | no | `"app_version"` | Dimension for the crashes report |
| `startDate` | string | no |  | Window start in YYYY-MM-DD. With endDate, reads every month the window touches and filters rows to it |
| `endDate` | string | no |  | Window end in YYYY-MM-DD |

<!-- /params:play_store_stats -->

Set `SEO_MCP_PLAY_BUCKET` to the reporting bucket (`gs://pubsite_prod_...` and the bare name both work) and `SEO_MCP_PLAY_CREDENTIALS` to a service account key with read access to that bucket, falling back to `GOOGLE_APPLICATION_CREDENTIALS`. Read access to the bucket is a different grant from the Play Console invite `play_vitals` needs. `month` defaults to the current UTC month.

### `app_store_listing`

Reads an App Store listing through App Store Connect and measures each locale's fields against Apple's limits: name 30, subtitle 30, keywords 100, promotional text 170. Apple indexes the name, subtitle, and keyword field only, so the description is reported but never scored, and a field one character over its limit is dropped silently rather than rejected, which is why every field is reported against its limit. Promotional text is called out separately because it is the only one of these that can be changed on a live version without a review.

An app can hold a live record and an editable one at the same time, so `state` selects which is read and the result states the record and version it used. When the record you asked for does not exist, the other one is reported and a note says so rather than passing it off as what you asked for.

The reported state comes from `appVersionState`, falling back to the deprecated `appStoreState`. The two spell the same thing differently: a live listing reads `READY_FOR_DISTRIBUTION` where the deprecated attribute said `READY_FOR_SALE`. Output captured before and after that change will differ on the string alone, with nothing having happened to the listing.

```json
{ "bundleId": "com.example.app", "state": "live", "platform": "IOS", "storefronts": ["us", "gb"] }
```

<!-- params:app_store_listing -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `appId` | string | no |  | App Store Connect numeric app id; provide this or bundleId |
| `bundleId` | string | no |  | Bundle id, resolved to an app id when appId is not given; provide this or appId |
| `platform` | one of IOS, MAC_OS, TV_OS, VISION_OS | no | `"IOS"` | App Store platform whose version is read |
| `state` | one of live, editable | no | `"live"` | Read the live listing or the editable one being prepared for release |
| `storefronts` | list of string | no | `["us"]` | Storefront country codes for the public ratings lookup |

<!-- /params:app_store_listing -->

Provide `appId` or `bundleId`. Set `SEO_MCP_ASC_KEY_PATH` to the `.p8` private key and `SEO_MCP_ASC_KEY_ID` to its key id, plus `SEO_MCP_ASC_ISSUER_ID` for a team key (individual keys have no issuer id). The key and the token it signs never appear in output.

A team key reaches every app on the team, so one key can serve them all. What limits it is the role it was given, and Apple does not let a key's role be changed afterwards: the only edit offered is Revoke. An App Manager key reads listings but not Sales and Trends or analytics reports, so those need a separate key created with Admin, Finance, or Sales and Reports rather than an upgrade of the one you have.

`ratings` is a list, one entry per requested storefront, not an object keyed by storefront:

```json
{ "ratings": [{ "storefront": "us", "source": "itunes-lookup", "averageUserRating": 4.5, "userRatingCount": 12 }] }
```

The star rating does not come from App Store Connect. Its API has no aggregate
rating resource at all, only age ratings, so the rating is read from the public
App Store storefront lookup while every other field on this tool comes from App
Store Connect. Two sources reporting one number that looks the same either way,
which is why each entry carries `source`. A rating from a store page and a
rating from a private API are not interchangeable and should not be compared as
if they were the same measurement.

### `list_snapshots`

Lists the snapshot documents already in the snapshot directory, newest first, with when each was taken, the window it covers, and how many properties, apps, packages and plugins it holds.

```json
{ "limit": 50 }
```

<!-- params:list_snapshots -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `limit` | number | no | `50` | Maximum snapshots to return, newest first |

<!-- /params:list_snapshots -->

A snapshot pair is worthless if nothing can say which files exist, and every caller was otherwise left keeping its own index of a directory the server owns. A file in the directory that is not a snapshot document is listed with its error rather than hidden, so a name you expect to find never quietly reads as absent. A missing directory is an empty list, not a failure: nothing has been captured yet. `total` and `truncated` sit beside the list because the command line prints the structured half alone, where a page cut at `limit` would otherwise read as the whole history.

### `snapshot`

Captures four surfaces into one timestamped document: Search Console totals and top rows per property, App Store listings, Google Play installs and traffic, and WordPress.org stats. Core Web Vitals field data, Android vitals, App Store sales and App Store reviews are not in it; `crux_field_data`, `play_vitals`, `app_store_sales` and `app_store_reviews` read those. This is the tool for recording a point in a series, because none of the consoles keep a history you can diff against later.

Search Console totals come from the **date** dimension, never by summing the query dimension. Google withholds low-volume queries, so a query-level sum undercounts, and that gap reads later as a decline that never happened.

A surface that cannot be read is recorded in place with its error and named in `surfacesWithErrors`, never omitted, because a surface that silently vanishes reads later as a drop to zero. One slow surface times out without taking the document down.

```json
{
  "properties": ["sc-domain:example.com"],
  "apps": ["1234567890"],
  "packages": ["com.example.app"],
  "slugs": ["akismet"],
  "windowDays": 28,
  "outPath": "2026-09-03.json"
}
```

<!-- params:snapshot -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `properties` | list of string | no | `[]` | Search Console properties to capture |
| `apps` | list of string | no | `[]` | App Store apps, each a numeric app id or a bundle id |
| `packages` | list of string | no | `[]` | Google Play package names |
| `slugs` | list of string | no | `[]` | WordPress.org plugin slugs |
| `windowDays` | number | no | `28` | Search Console window in days, ending today |
| `platform` | one of IOS, MAC_OS, TV_OS, VISION_OS | no | `"IOS"` | App Store platform for the app surfaces |
| `storefronts` | list of string | no | `["us"]` | Storefront country codes for App Store ratings |
| `outPath` | string | no |  | File name or path inside the snapshot directory (SEO_MCP_SNAPSHOT_DIR, default ~/.config/seo-mcp/snapshots); must end in .json, or pass auto to name the file after the moment it was taken. An existing file is not overwritten unless overwrite is true |
| `overwrite` | boolean | no | `false` | Replace an existing file at outPath; without it an existing file is left alone and reported |

<!-- /params:snapshot -->

Pass `outPath` to write the document where `compare_snapshots` can read it later, or `outPath: "auto"` to have it named after the moment it was taken (`2026-09-04T00-15Z.json`), which is what makes an unattended run produce a series rather than one file overwritten forever. It is a file name inside the snapshot directory, `SEO_MCP_SNAPSHOT_DIR` or `~/.config/seo-mcp/snapshots` by default; a path that resolves outside that directory or does not end in `.json` is refused, and an existing file is left in place and reported unless you pass `overwrite: true`. A model chooses this string, so the directory is the boundary that keeps a tool call from truncating anything else on the machine. Position and CTR are `null` rather than `0` when a window has no impressions, so an empty window never compares against real data as a collapse.

### `compare_snapshots`

Reads two snapshot documents and reports what changed between them: clicks, impressions and position per property, page-level and query-level movers above an impressions floor, install and rating deltas, App Store version and locale-count changes, the per-locale name, subtitle, keyword, promotional-text and description lengths plus which fields crossed a character limit, Google Play traffic sources by visitors and acquisitions, and the WordPress.org five-star histogram.

```json
{ "from": "2026-08-06.json", "to": "2026-09-03.json", "minImpressions": 100 }
```

<!-- params:compare_snapshots -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `from` | string | yes |  | Snapshot file name or path inside the snapshot directory; latest names the newest snapshot on disk and previous the one before it |
| `to` | string | yes |  | Snapshot file name or path inside the snapshot directory; latest names the newest snapshot on disk and previous the one before it |
| `minImpressions` | number | no | `100` | Ignore page position moves below this many impressions on both sides |

<!-- /params:compare_snapshots -->

`from` and `to` resolve inside the same snapshot directory as `snapshot`'s `outPath`, so this tool reads snapshots and nothing else. Either one also takes `latest` or `previous` instead of a file name, which is the comparison almost every caller actually wants and the only one they can ask for without listing the directory first. Both skip a file that will not parse, and asking for `previous` with a single snapshot on disk says so rather than comparing a document against itself.

It does arithmetic, never judgement. It will not tell you whether a change was good or what caused it, because a diff cannot support that claim. A surface that failed or is missing on either side is marked not comparable and named, so a collection failure is never read as a change, and a file that is not a snapshot document is refused rather than half-parsed.

Snapshots taken before a field was captured still compare. A field one side does not carry comes back as a `null` delta rather than as a change, and an app pair with no per-locale lengths on either side reports `localesComparable: false` instead of a listing emptied to zero characters.

### `app_store_reviews`

Reads App Store customer reviews and your responses, filtered by star rating or storefront, following Apple's own paging cursor.

```json
{ "bundleId": "com.example.app", "rating": [1, 2], "territory": "USA", "limit": 100 }
```

<!-- params:app_store_reviews -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `appId` | string | no |  | App Store Connect numeric app id; provide this or bundleId |
| `bundleId` | string | no |  | Bundle id; provide this or appId |
| `rating` | list of number | no |  | Only these star ratings |
| `territory` | string | no |  | Only reviews from this storefront |
| `sort` | one of -createdDate, createdDate, rating, -rating | no | `"-createdDate"` | Sort order; newest first by default |
| `limit` | number | no | `100` | Maximum reviews to return across pages |
| `maxPages` | number | no | `5` | Maximum pages to follow |

<!-- /params:app_store_reviews -->

It reports `meanOfFetched` and `histogramOfFetched`, never "the rating". Those describe only the reviews this call returned, and a filtered or truncated page would make a mean a different number wearing the same name. App Store Connect exposes no aggregate rating resource at all, which is verifiable in Apple's own OpenAPI specification: every path matching "rating" is an *age* rating.

### `app_store_discovery`

Reads the App Store surfaces beyond the listing text: **search keywords** (Apple's actual indexed keyword list, held per locale), app tags, product page optimization experiments, custom product pages, in-app events, territory availability, and review summarizations.

```json
{ "bundleId": "com.example.app", "locales": ["en-US", "ar-SA"], "platform": "IOS" }
```

<!-- params:app_store_discovery -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `appId` | string | no |  | App Store Connect numeric app id; provide this or bundleId |
| `bundleId` | string | no |  | Bundle id; provide this or appId |
| `include` | list of one of searchKeywords, appTags, experiments, customProductPages, appEvents, availability, reviewSummarizations | no | `[]` | Which discovery surfaces to read; empty reads all of them |
| `limit` | number | no | `50` | Rows per resource |
| `locales` | list of string | no | `["en-US"]` | Locales for per-locale resources such as searchKeywords |
| `platform` | one of IOS, MAC_OS, TV_OS, VISION_OS | no | `"IOS"` | Platform for resources that require one |
| `includeRows` | boolean | no | `false` | Include every raw row as well as the counts; off by default so a summary call stays small |

<!-- /params:app_store_discovery -->

Each resource carries its own required parameters: `searchKeywords` needs both a platform and a locale filter, `appAvailabilityV2` is a to-one relationship that rejects `limit` outright. A resource this key or app cannot serve is reported as `available: false`, never as an empty list, because "no experiments" and "cannot read experiments" are different answers.

### `crux_field_data`

Real-user Core Web Vitals for an origin or a single URL from the Chrome UX Report: the current 28-day field record, with p75s and full histogram bins.

```json
{ "origin": "https://example.com", "formFactor": "PHONE" }
```

<!-- params:crux_field_data -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `origin` | string | no |  | Origin such as https://example.com; aggregates every page under it. Give origin or url, not both |
| `url` | string | no |  | A single page URL. Give origin or url, not both |
| `formFactor` | one of PHONE, TABLET, DESKTOP | no |  | Device class; omit for all form factors combined |
| `metrics` | list of string | no |  | Metric names to request; omit for all available |

<!-- /params:crux_field_data -->

This is field data, not a lab test; keep `pagespeed` for Lighthouse audits. Google is discontinuing PageSpeed's own real-world data, so this is where field measurements move. An origin with too few anonymized samples returns `hasData: false` with a note rather than an error or zeros, since a zeroed LCP would read as a catastrophic regression.

### `crux_history`

The same field metrics as a weekly series, roughly six months of history.

```json
{ "origin": "https://example.com", "formFactor": "PHONE", "collectionPeriodCount": 25 }
```

<!-- params:crux_history -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `origin` | string | no |  | Origin such as https://example.com; aggregates every page under it. Give origin or url, not both |
| `url` | string | no |  | A single page URL. Give origin or url, not both |
| `formFactor` | one of PHONE, TABLET, DESKTOP | no |  | Device class; omit for all form factors combined |
| `metrics` | list of string | no |  | Metric names to request; omit for all available |
| `collectionPeriodCount` | number | no |  | Weekly periods to return, 1 to 40. Documented history is about six months; the API decides what it actually has |

<!-- /params:crux_history -->

Each period is a 28-day rolling window stepped weekly, so consecutive points overlap by three weeks and a single week-on-week move is not an independent change. Periods with too few samples keep their place in the series as `null` rather than being dropped, so the values stay aligned with `collectionPeriods`.

### `app_store_sales`

Reads App Store Sales and Trends: units downloaded per day, per territory, per app, summarized by SKU.

```json
{ "reportDate": "2026-08-30", "frequency": "DAILY", "reportType": "SALES", "reportSubType": "SUMMARY" }
```

<!-- params:app_store_sales -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `reportDate` | string | no |  | Report date. DAILY and WEEKLY take YYYY-MM-DD (WEEKLY means the week's ending date), MONTHLY takes YYYY-MM, YEARLY takes YYYY. Defaults to the most recent complete period for the frequency |
| `frequency` | one of DAILY, WEEKLY, MONTHLY, YEARLY | no | `"DAILY"` | Report period |
| `reportType` | one of SALES, PRE_ORDER, SUBSCRIPTION, SUBSCRIPTION_EVENT, SUBSCRIBER, INSTALLS, FIRST_ANNUAL | no | `"SALES"` | Sales and Trends report type |
| `reportSubType` | one of SUMMARY, DETAILED, SUMMARY_INSTALL_TYPE, SUMMARY_TERRITORY, SUMMARY_CHANNEL | no | `"SUMMARY"` | Report sub type |
| `version` | string | no |  | Report version, such as 1_0 or 1_3, when the default is not accepted |
| `includeRows` | boolean | no | `false` | Include every raw report row as well as the per-SKU summary |

<!-- /params:app_store_sales -->

Set `SEO_MCP_ASC_VENDOR_NUMBER`; App Store Connect shows the vendor number under Payments and Financial Reports, beside the legal entity name. Sales and Trends needs a team key with the Admin, Finance, or Sales and Reports role. Daily reports land the next day, so the default report date is two days back rather than today. `reportDate` takes the shape its frequency needs: `YYYY-MM-DD` for `DAILY` and for `WEEKLY`, where it means the week's ending Sunday, `YYYY-MM` for `MONTHLY`, and `YYYY` for `YEARLY`; leave it out and each frequency defaults to its most recent complete period.

A period with no sales returns `hasData: false` with a note, not an error, because a quiet day should not look like a broken integration. Units come from the Sales and Trends pipeline, which is separate from App Analytics and can disagree with it.

### `play_vitals`

Reads Android vitals from the Play Developer Reporting API: crash rate, ANR rate, error counts and startup metrics, daily or hourly, with optional breakdowns such as `versionCode` or `countryCode`.

```json
{ "packageName": "com.example.app", "metricSets": ["crashRate", "anrRate"], "days": 28 }
```

<!-- params:play_vitals -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `packageName` | string | yes |  | Android package name |
| `metricSets` | list of one of crashRate, anrRate, errorCount, slowStartRate, excessiveWakeupRate | no | `["crashRate","anrRate"]` | Which Android vitals metric sets to query |
| `aggregationPeriod` | one of DAILY, HOURLY | no | `"DAILY"` | DAILY is reported in America/Los_Angeles, HOURLY in UTC |
| `days` | number | no | `28` | How many days back to query |
| `dimensions` | list of string | no | `[]` | Breakdown dimensions such as versionCode or countryCode |
| `pageSize` | number | no | `1000` | Rows per metric set |
| `includeRows` | boolean | no | `false` | Include every raw row as well as the counts; off by default so a summary call stays small |

<!-- /params:play_vitals -->

Set `SEO_MCP_PLAY_CREDENTIALS` to the service account key, falling back to `GOOGLE_APPLICATION_CREDENTIALS`. The account also has to be invited in Play Console under Users and permissions with the permission to view app information and app quality. The token is minted for the `playdeveloperreporting` scope, which is a separate grant from the Cloud Storage read `play_store_stats` needs. One account can hold both, but a key that only has the bucket grant gets a 403 here.

The window is clamped to the freshness the API reports for itself, since it refuses an end date past that and asking through today always fails. The result says how current the data actually is, so zero rows through a known date is distinguishable from zero rows because the day has not landed. This API carries no acquisition or conversion data; `play_store_stats` has that.

## Google Ads

Reads the account through the API rather than the console. A console table pages, so a count taken from the first screen can be wrong without looking wrong: one keyword count was read as two when the answer was five, because the table shows ten rows and there were fourteen. These tools return every row.

Set `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` and `GOOGLE_ADS_CUSTOMER_ID` (dashes optional). Two conveniences: `GOOGLE_ADS_CLIENT_SECRET_PATH` reads the client id and secret out of the OAuth client JSON that Google Cloud gives you, and `GOOGLE_ADS_ENV_FILE` points at an existing `.env`-shaped file holding any of these, so a refresh token that already lives somewhere is read in place rather than copied. The process environment wins over the file. `GOOGLE_ADS_API_VERSION` overrides the API version.

### `ads_campaigns`

Campaign name, status, daily budget, impressions, clicks, cost and conversions over a window.

```json
{ "days": 30 }
```

<!-- params:ads_campaigns -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `days` | number | no | `30` | How many days back to report, ending today |

<!-- /params:ads_campaigns -->

### `ads_keywords`

Every keyword with its state, effective CPC bid, approval status, serving status and metrics.

**`ELIGIBLE` does not mean serving.** It means approved and capable of serving, and a paused keyword reports it. That is why `status` is returned alongside it: without it a paused keyword's row is identical to a live one, and someone who has just paused three keywords reads that as the pause not having taken. Paused keywords are named in a note rather than dropped, because silently removing rows is the same failure one layer down: you ask whether a keyword is in the account and get nothing back. Pass `status` to filter deliberately.

```json
{ "days": 30 }
```

<!-- params:ads_keywords -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `days` | number | no | `30` | How many days back to report, ending today |
| `status` | one of ENABLED, PAUSED, REMOVED | no |  | Limit to one keyword state. Omitted, every keyword is returned with its state named, because dropping rows silently is how a count taken from this tool goes wrong the way a console count does |

<!-- /params:ads_keywords -->

### `ads_ads`

Every ad with its ad strength, policy approval status, serving status and metrics.

```json
{ "days": 30 }
```

<!-- params:ads_ads -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `days` | number | no | `30` | How many days back to report, ending today |

<!-- /params:ads_ads -->

### `ads_ad_copy`

Reads what an ad actually says. `ads_ads` gives the id, strength, approval and status; this gives the text, which is the thing every creative question needs and the reason that question otherwise ends in the browser.

```json
{ "adGroup": "brand-exact" }
```

<!-- params:ads_ad_copy -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `adGroup` | string | no |  | Limit to one ad group by name. Omitted, every ad in the account is read, which is what answers whether a headline is repeated across ad groups |
| `adId` | string | no |  | Limit to one ad by its numeric id, for reading back the copy that was supposed to ship |
| `includeRemoved` | boolean | no | `false` | Include removed ads. Off by default: a removed ad's copy is history, and it crowds out the ads that are serving |

<!-- /params:ads_ad_copy -->

Every headline and description comes back with its pinning and Google's own performance label, plus the display path, the final URLs, and the policy topics behind a limited or disapproved status. **The approval word says something is wrong; the topic says what.** `APPROVED_LIMITED` beside `TRADEMARKS_IN_AD_TEXT` is a fix; `APPROVED_LIMITED` on its own is a trip to the console.

It also answers the two questions a per-ad view cannot:

- **Why is strength Poor.** The count against what Google wants, `3 of 15 headlines, 2 of 4 descriptions`, and how many assets are pinned. Pinning is usually deliberate, usually invisible in the strength word, and a common reason strength reads lower than the copy deserves. Text repeated inside one ad is named too, since a repeated asset takes a slot without adding a variation.
- **Is a headline duplicated across ads.** Headline text appearing in more than one ad is listed with the ads and ad groups carrying it. Two ads in one ad group that share their headlines are not two variants being tested against each other, and nothing in the console says so at a glance.

Removed ads are excluded unless `includeRemoved` is set, and only a responsive search ad carries text in these fields: any other ad type is listed with its type and no copy, rather than as an ad with nothing to say. Assets attached to the ad, campaign or account, such as sitelinks, promotions and prices, are **not** read here, so an ad that looks thin in this output may still be serving with assets alongside it.

### `ads_assets`

What is attached under the ad: sitelinks, callouts, structured snippets, promotions, prices, call and image assets, at all three levels, with **what each one actually says** rather than only its type and id.

```json
{ "campaign": "search-uk-us-2026-09" }
```

<!-- params:ads_assets -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `campaign` | string | no |  | Limit campaign and ad group assets to one campaign by name. Account-level assets are still listed, because they apply to every campaign including this one |
| `type` | one of SITELINK, CALLOUT, STRUCTURED_SNIPPET, PROMOTION, PRICE, CALL, IMAGE | no |  | Limit to one asset type. Omitted, every type is listed, including types this tool has no shaped reading for |
| `includeRemoved` | boolean | no | `false` | Include links whose status is removed. Off by default: a removed asset is history and crowds out the ones that can serve |

<!-- /params:ads_assets -->

A promotion reads back as `up to 20% off on Pro plan with code LAUNCH20, 2026-01-01 to 2026-01-31`, not as `PROMOTION #4417`. That matters because Google states a promotion's percentage in millionths, where 1,000,000 is 100%, so the raw field is a number nobody would recognise as a discount. Prices come back with their offerings and currency, sitelinks with their descriptions.

Three things worth knowing before reading a result:

- **An account-level asset applies to every campaign**, so it is listed even when you name one campaign. This is the other half of `ads_ad_copy`: an ad that looks bare there may be serving with four sitelinks and a promotion beside it, none of which are attached to its campaign.
- **Attached is not shown.** Google decides per auction whether to show an asset and which ones. This says what is available to serve, not what served.
- **A campaign name that matches nothing is refused, not answered.** A typo used to come back as zero rows with no error, next to a note explaining that account-level assets are listed too, so the reader concluded the account had none. The name is resolved before anything is read, and an unknown one says so. The caller who mistypes a campaign is exactly the caller who then says "that campaign has no sitelinks" and acts on it.
- **A level that cannot be read is reported as an error in place.** The three levels are three separate queries, and if one fails the other two still come back with `levelErrors` naming the one that did not. An empty list that quietly meant "the query broke" would read as "nothing attached", which is the wrong answer to the only question this tool gets asked.

A type this tool has no shaped reading for is named with its asset type and its field type and left at that, rather than given an invented summary: a `TEXT` asset filed as `BUSINESS_NAME` is mostly described by the second half. The field type is shown only where it differs from the asset type, since the two are usually the same word and repeating it is noise. Asset metrics are not reported here.

### `ads_query`

An arbitrary GAQL `SELECT` for a question the shaped reads do not cover. GAQL has no statement other than `SELECT`, so this cannot change anything, and a query that does not start with `SELECT` is refused.

```json
{ "query": "SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS" }
```

<!-- params:ads_query -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | yes |  | A GAQL SELECT statement. GAQL has no other statement, so this cannot change anything |

<!-- /params:ads_query -->

### `ads_search_terms`

The queries that actually triggered an ad, with the keyword each one matched. This is the paid equivalent of the Search Console query dimension, and it carries the same caveat: Google withholds terms too few people searched, so a term that is not listed is unknown rather than absent.

```json
{ "days": 90, "minImpressions": 1 }
```

<!-- params:ads_search_terms -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `days` | number | no | `30` | How many days back to report, ending today |
| `minCost` | number | no | `0` | Drop search terms that cost less than this over the window |
| `minImpressions` | number | no | `0` | Drop search terms below this many impressions |
| `zeroConversionsOnly` | boolean | no | `false` | Keep only terms that converted nothing, which is the list that feeds negative keywords |

<!-- /params:ads_search_terms -->

### `ads_changes`

What changed in the account, when, which fields, by whom, and whether it came from a tool or from someone in the browser: `client` is `GOOGLE_ADS_API` for the former and `GOOGLE_ADS_WEB_CLIENT` for the latter. This is the audit trail for anything `ads_update` writes, and for console edits made by hand. Google keeps 30 days, so a longer window is refused rather than silently truncated.

```json
{ "days": 14, "limit": 100 }
```

<!-- params:ads_changes -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `days` | number | no | `14` | How many days of change history to read, ending now. Google keeps 30 days and refuses more |
| `limit` | number | no | `100` | Most recent changes to return |

<!-- /params:ads_changes -->

### `ads_negatives`

The negative keywords already in place, at campaign, ad group or shared-set level. A negative blocks traffic without leaving any record that it did, so this is the list to check when a keyword stops serving and nothing looks wrong, and before adding a term that may already be there.

```json
{ "level": "all" }
```

<!-- params:ads_negatives -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `level` | one of campaign, adGroup, sharedSet, all | no | `"all"` | Which negatives to read. A term blocked at campaign level is blocked everywhere in it; a shared set applies to every campaign it is attached to |

<!-- /params:ads_negatives -->

### `ads_negatives_update`

Adds or removes negative keywords in a batch, enumerated one by one. There is no pattern or match-all form on purpose: "block every term matching X" is one typo away from an account-sized mistake, and an explicit list cannot make that mistake.

```json
{ "action": "add", "level": "campaign", "target": "search-uk-us", "keywords": ["free", "crack"], "matchType": "EXACT", "dryRun": false }
```

<!-- params:ads_negatives_update -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | one of add, remove | yes |  | Add negative keywords or remove existing ones. Removal matters as much as adding: a wrong negative shows up as nothing at all |
| `level` | one of campaign, adGroup | no | `"campaign"` | Where the negatives live. A campaign-level negative blocks the term everywhere in that campaign |
| `target` | string | yes |  | The campaign or ad group name. It must match exactly one or nothing is changed |
| `keywords` | list of string | yes |  | The negative terms, enumerated one by one. There is no pattern or match-all form: a selector is one typo away from blocking a whole campaign |
| `matchType` | one of BROAD, PHRASE, EXACT | no | `"EXACT"` | How each term blocks. BROAD blocks any query containing all its words, which is the setting that can silently kill a campaign |
| `dryRun` | boolean | no | `true` | Report what would change, and which proposed negatives would block a live keyword, without changing anything |
| `confirm` | boolean | no | `false` | Perform the batch even though a guard tripped. The dry run lists what tripped, so this confirms something already read |

<!-- /params:ads_negatives_update -->

Negatives feel safe because they only reduce spend, and that instinct is what makes them dangerous. **A wrong bid shows up as spend. A wrong negative shows up as nothing**: the traffic stops arriving, the term leaves the search terms report, and no row anywhere says why. Adding `backup` as a broad negative to a backup-plugin campaign ends its traffic, and Google reports no error because it is a perfectly valid negative.

So before adding anything, every proposed negative is checked against the campaign's own live keywords, and the batch is refused unless `confirm` is set. The refusal names what it would have cost: `"backup" as a BROAD negative would block this campaign's own keyword "wordpress backup", which served 41 impressions`. The check mirrors Google's matching closely but Google is the authority, and it is deliberately generous, because a false warning costs a sentence and a missed one costs the campaign.

Removals are not collision-checked. Removing a negative can only let traffic through, which shows up as spend rather than as silence.

### `ads_update`

Changes one keyword bid, campaign daily budget, campaign status, ad status or keyword status. This is the only tool here that spends money, so it is built to be hard to fire by accident.

**Pausing a keyword is its own kind, because dropping its bid is not the same thing.** A keyword with a lowered bid is still enabled, still eligible, and still competing for the same daily budget. If the reason to act was that budget is the constraint, lowering the bid does not free any of it.

```json
{ "kind": "budget", "target": "search-uk-us-2026-09", "value": "5.00", "dryRun": false, "confirm": true }
```

<!-- params:ads_update -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | one of bid, budget, campaignStatus, adStatus, keywordStatus | yes |  | What to change: a keyword's max CPC bid, a campaign's daily budget, a campaign's status, an ad's status, or a keyword's status. Use keywordStatus to stop one keyword serving; dropping its bid is not the same thing, because the keyword stays eligible and keeps competing for the same budget |
| `target` | string | yes |  | The keyword text, the campaign name, or the numeric ad id. It must match exactly one thing or the call is refused |
| `value` | string | yes |  | The new amount in dollars for a bid or budget, or pause or enable for a status |
| `dryRun` | boolean | no | `true` | Report what would change and which guards it trips, without changing anything. On by default: this tool spends money, so performing a change has to be asked for |
| `confirm` | boolean | no | `false` | Perform a change that trips a guard. Ignored on a dry run. The dry run lists the guard reasons, so this confirms something already read rather than something unseen |

<!-- /params:ads_update -->

Four rails, each from a real failure rather than a hypothetical:

- **A dry run by default.** `dryRun` defaults to true, so omitting it reports the change and stops. A required parameter enforces this better than a command-line flag, because a flag can be forgotten and a default cannot.
- **Exactly one match or refuse.** A target that matches nothing is a typo; a target that matches two is a request to change something you did not name. Both stop before any write.
- **Guards with reasons, in words.** More than three times the current amount, more than $25 on a single bid or daily budget, or pausing something that is currently serving. A budget change also states the monthly equivalent, because $30 a day reads small and is about $912 a month. The dry run lists the reasons, and `confirm` then confirms something you have read rather than something unseen.
- **The value is read back after the write.** An HTTP 200 means the request was accepted, not that it stored what you meant. The result carries `readBack` and `matches`, and a mismatch is returned as an error.

A change that would be a no-op says so instead of sending a pointless mutation.

From the command line this tool needs `--allow-spend` as well as `--allow-write`. One flag authorising both "resubmit a sitemap" and "triple a daily budget" is not a gate.

### `ads_update_batch`

Changes several keyword bids, or several campaign daily budgets, in one call. One kind per call: a total across bids and budgets would add a per-click ceiling to a per-day amount, and no honest sentence describes that sum.

```json
{ "kind": "bid", "changes": [{ "target": "wordpress backup", "value": 0.85 }, { "target": "backup plugin", "value": 0.6 }], "dryRun": false, "confirm": true }
```

<!-- params:ads_update_batch -->

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | one of bid, budget | yes |  | One kind per call. A summed guard is only honest inside one kind: bids and budgets sum to dollars, statuses do not, and mixing them makes the total unreadable |
| `changes` | JSON list | yes |  | A named list of pairs, each with its own value. There is no selector form: enumeration cannot make the mistake that a pattern can |
| `dryRun` | boolean | no | `true` | Resolve and price every entry and report the total, without changing anything |
| `confirm` | boolean | no | `false` | Perform the batch even though a guard tripped. The dry run lists every reason, so this confirms something already read |

<!-- /params:ads_update_batch -->

It is a named list of pairs, not a rule applied to many things. There is no "raise everything by 20%" and no selector, because the mistake this tool exists to prevent is exactly the one a selector makes easy: a pattern that matches more than the caller pictured, applied before anyone can see the list it produced. Every entry names one target and the value it should end at, and the dry run prints that list back.

Four things it does that `ads_update` called in a loop does not:

- **Everything resolves before anything is written.** If entry four matches nothing, entries one to three are not already live. A loop of single calls fails halfway and leaves the account in a state nobody chose, with no single row anywhere saying so.
- **The sum is guarded, not only each entry.** Five raises that are each within the per-item ceilings are still one large spend change together, and doing them one at a time is how that goes unnoticed.
- **The one entry out of line with the rest is named.** Nineteen bids moving a few cents and one moving $40 can sit under every ceiling and still be the mistake. An entry whose move is far larger than the middle of the batch is flagged by name, because a typo hides inside an acceptable total, and that is exactly how a batch differs from the same writes sent one at a time.
- **Two entries cannot name the same thing.** The same target twice is refused, and so are two differently named campaigns that share one budget, where the total would count it twice and the second write would quietly win.

The per-entry ceilings stay flat however long the list is, because the per-entry question is whether that one entry is a typo and a typo does not get more acceptable in a bigger batch. The ceiling on the batch total grows with the batch, slowly: twenty entries is not twenty times the risk of one, it is one decision taken once. A guard that trips on every realistic batch is not a guard, it is a checkbox, and once `confirm` is routine it gets passed unread.

The total is always stated in words whether or not anything tripped, since the sentence is what gets read and the guard is only what stops you when it does not. For budgets that is the monthly figure both ways: `These daily budgets come to $13.00 a day, about $395 a month, up from $10.00 a day, about $304 a month.`

Every value is read back after the write, entry by entry. The result names which entries did not store what was sent first, then which are live with what the account now holds, because on a partial landing the question is never how many but which ones. One accepted request is one acceptance, not N stored values, and a batch is exactly where a partial landing hides. The batch is sent as a single request without partial failure, so a rejected write leaves nothing behind, and the error says so rather than leaving you to guess.

Like `ads_update`, it needs `--allow-spend` as well as `--allow-write` from the command line.

## Running a tool from the command line

Every tool above is also runnable without an MCP client, which is what to use when a result has to land in a file that a later run can diff:

```sh
seo-mcp query search_analytics --site-url sc-domain:example.com --start-date 2026-08-05 --out /tmp/sa.json
seo-mcp query --help                  # list the tools
seo-mcp query wporg_plugin --help     # list one tool's parameters
```

Every run names its own version on stderr (`seo-console-mcp 0.15.1 running wporg_plugin`), so stdout stays parseable and an `--out` file stays pure JSON. **A result does not otherwise say which binary produced it**, and that is not academic: `npx` will reuse a cached older build with no error at all, and a failed install leaves the previous version in place and working. What is running, what the version range resolves to, and what npm calls latest are three values that usually agree and independently do not have to.

Flags are the tool's parameter names in kebab-case (`--site-url` for `siteUrl`); the camelCase spelling works too. List values are comma-separated. The result is written to `--out`, or to stdout when it is omitted, and a failure exits non-zero with the message on stderr. It runs the same implementation the MCP surface exposes, so the two cannot drift.

Tools that change data (`submit_sitemap`, `delete_sitemap`, `request_recrawl`, `indexnow_submit`) are marked `(write)` in the listing and refuse to run from the command line unless `--allow-write` is passed.

A history is one cron line away, and the server deliberately does not own a scheduler: your machine already has one that survives a restart.

```sh
# every Monday at 06:00, one snapshot named after the moment it was taken
0 6 * * 1 seo-mcp query snapshot --properties sc-domain:example.com --out-path auto
```

## Development

```sh
npm run dev
npm run build
npm test
npm run lint
npm run format
npm run format:check
npx tsc --noEmit
```

Tests use injected fake Google clients and never call live Google services. Do not commit service account keys. In addition to `*.key.json`, this repository ignores `credentials*.json`, `.env*`, PEM files, and P12 files.
