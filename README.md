# seo-mcp

`seo-mcp` is a stdio [Model Context Protocol](https://modelcontextprotocol.io/) server for Google Search Console, PageSpeed Insights, and on-page SEO audits. It gives MCP clients twenty-eight tools covering verified Search Console properties and the other places products get discovered, the App Store, Google Play, WordPress.org, and real-user Core Web Vitals, while keeping the HTML audit, PageSpeed, IndexNow, keyword ideas, and WordPress.org tools usable without Google service account credentials. Every tool also runs from the command line, so a result can be written to a file instead of into a model's context, and `snapshot` records every surface at one moment so a later run can diff against it.

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
| `snapshot`, `compare_snapshots` | optional `SEO_MCP_SNAPSHOT_DIR` | where snapshot files live, defaulting to `~/.config/seo-mcp/snapshots` |
| `verify` | `CLOUDFLARE_API_TOKEN` | Cloudflare, Zone.DNS:Edit |
| `app_store_listing`, `app_store_discovery`, `app_store_reviews` | `SEO_MCP_ASC_KEY_PATH`, `SEO_MCP_ASC_KEY_ID`, `SEO_MCP_ASC_ISSUER_ID` | App Store Connect team key, any role that can read the app |
| `app_store_sales` | the above plus `SEO_MCP_ASC_VENDOR_NUMBER` | team key created with Admin, Finance, or Sales and Reports |
| `play_store_stats` | `SEO_MCP_PLAY_BUCKET`, `SEO_MCP_PLAY_CREDENTIALS` | service account with read access to the reporting bucket |
| `play_vitals` | `SEO_MCP_PLAY_CREDENTIALS` | service account invited in Play Console with app quality access |

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

`pagespeed` is public and does not use the service account. Set `SEO_MCP_PAGESPEED_KEY` or pass `apiKey` to that tool for a higher PageSpeed Insights quota. `seo_audit`, `audit_site`, and `indexnow_submit` also need no Google credentials; `indexnow_submit` instead takes an IndexNow key via `key` or `SEO_MCP_INDEXNOW_KEY`. `keyword_ideas` only needs them when `siteUrl` is passed for the Search Console cross-reference. App Store Sales and Trends reads `SEO_MCP_ASC_VENDOR_NUMBER`. The Chrome UX Report tools read `SEO_MCP_CRUX_KEY`, falling back to `SEO_MCP_PAGESPEED_KEY` when the same key is allowed to call `chromeuxreport.googleapis.com`. `snapshot` and `compare_snapshots` keep their documents in `SEO_MCP_SNAPSHOT_DIR`, defaulting to `~/.config/seo-mcp/snapshots`, and cannot read or write outside it. The table under Requirements maps every tool to what it needs.

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

`siteUrl` is required. `startDate` and `endDate` default to the latest 28-day UTC window. `dimensions` defaults to `["query"]`; allowed values are `query`, `page`, `country`, `device`, `date`, and `searchAppearance`. `rowLimit` defaults to 25 and is capped at 25,000. `maxTableRows` defaults to 25 and caps only the text table; structured rows remain complete. Set it to 0 for a summary without a table. `type` may be `web`, `image`, `video`, or `news`.

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

### `list_sitemaps`

Lists sitemap path, submission/download times, pending/index flags, warning/error counts, and content counts.

```json
{
  "siteUrl": "https://www.example.com/"
}
```

### `submit_sitemap`

Submits a sitemap and refreshes its current state. This is a write operation. If submission succeeds but the state refresh fails, the result still confirms that Google accepted the write and reports the refresh warning.

```json
{
  "siteUrl": "sc-domain:example.com",
  "feedpath": "https://www.example.com/sitemap.xml"
}
```

### `delete_sitemap`

Removes a submitted sitemap from a Search Console property. This is a write operation. Set `dryRun` to `true` to preview the removal without changing Search Console.

```json
{
  "siteUrl": "sc-domain:example.com",
  "feedpath": "https://www.example.com/sitemap.xml",
  "dryRun": true
}
```

### `inspect_url`

Returns index coverage, verdict, robots state, indexing state, crawl time, fetch state, Google and user canonicals, mobile usability, and rich-result status.

```json
{
  "siteUrl": "sc-domain:example.com",
  "inspectionUrl": "https://www.example.com/products/widget"
}
```

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

It shares the `index_coverage` caps (`maxUrls` up to 50, `concurrency` up to 5) because both draw on the same URL Inspection quota. Resubmission only prompts a recrawl of pages whose sitemap `lastmod` is fresh, so keep `lastmod` accurate for changed URLs.

### `indexnow_submit`

Submits up to 10,000 changed URLs in one call to an [IndexNow](https://www.indexnow.org/) endpoint. Participating engines (Bing, Yandex, Naver, Seznam, Yep) share submissions with each other. Google does not use IndexNow; use `request_recrawl` for Google. This is a write operation and supports `dryRun`. It needs no Google credentials.

```json
{
  "urls": ["https://www.example.com/new-page", "https://www.example.com/updated-page"],
  "key": "your-indexnow-key"
}
```

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

`strategy` defaults to `mobile`. All four categories are requested by default. `apiKey` is optional and overrides `SEO_MCP_PAGESPEED_KEY` for that call.

### `seo_audit`

Fetches up to 10 MB of HTML with redirects enabled, a 15-second timeout, and an identifying user agent. It extracts title and description lengths, canonical, robots, H1s and heading outline, Open Graph and Twitter tags, JSON-LD types, image alt coverage, internal/external links, word count, language, and viewport. It flags missing or duplicate titles, a missing description, missing or multiple H1s, a missing canonical, and missing or invalid JSON-LD.

```json
{
  "url": "https://www.example.com/landing-page"
}
```

### `audit_site`

Fetches a sitemap and audits up to 50 of its page URLs with bounded concurrency. Sitemap indexes are supported with a hard cap of five child sitemap fetches. The result includes compact per-page findings, isolated page-fetch errors, a count of each shared issue, and explicit truncation and skipped counts. It does not require Google credentials.

```json
{
  "sitemapUrl": "https://www.example.com/sitemap.xml",
  "maxPages": 20,
  "concurrency": 5
}
```

`maxPages` defaults to 20 and `concurrency` defaults to 5. Their maximum values are 50 and 10, respectively.

### `wporg_plugin`

Looks up a WordPress.org plugin by slug and returns active installs, downloads, ratings, support threads, and version dates. It uses the public wp.org API and needs no credentials or API key. A plugin published within the last few days is reported with `possiblyLagging: true` when a field looks empty, because the wp.org API under-reports fresh plugins; the field may be live on the page already.

```json
{ "slug": "akismet" }
```

### `play_store_stats`

Reads the Google Play bulk reports for an app and returns Active Device Installs, plus store-listing visitors and acquisitions grouped by traffic source and search term. `hasPlaySearchRows` states outright whether any Play search traffic appears, since its absence is a finding rather than an error. Reports lag by days, so `lastDatePresent` is the last date actually in the files rather than today.

```json
{ "packageName": "com.example.app", "month": "202608" }
```

Set `SEO_MCP_PLAY_BUCKET` to the reporting bucket (`gs://pubsite_prod_...` and the bare name both work) and `SEO_MCP_PLAY_CREDENTIALS` to a service account key with read access to that bucket, falling back to `GOOGLE_APPLICATION_CREDENTIALS`. Read access to the bucket is a different grant from the Play Console invite `play_vitals` needs. `month` defaults to the current UTC month.

### `app_store_listing`

Reads an App Store listing through App Store Connect and measures each locale's fields against Apple's limits: name 30, subtitle 30, keywords 100, promotional text 170. Apple indexes the name, subtitle, and keyword field only, so the description is reported but never scored, and a field one character over its limit is dropped silently rather than rejected, which is why every field is reported against its limit. Promotional text is called out separately because it is the only one of these that can be changed on a live version without a review.

An app can hold a live record and an editable one at the same time, so `state` selects which is read and the result states the record and version it used. When the record you asked for does not exist, the other one is reported and a note says so rather than passing it off as what you asked for.

The reported state comes from `appVersionState`, falling back to the deprecated `appStoreState`. The two spell the same thing differently: a live listing reads `READY_FOR_DISTRIBUTION` where the deprecated attribute said `READY_FOR_SALE`. Output captured before and after that change will differ on the string alone, with nothing having happened to the listing.

```json
{ "bundleId": "com.example.app", "state": "live", "platform": "IOS", "storefronts": ["us", "gb"] }
```

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

### `snapshot`

Captures every surface into one timestamped document: Search Console totals and top rows per property, App Store listings, Google Play installs and traffic, and WordPress.org stats. This is the tool for recording a point in a series, because none of the consoles keep a history you can diff against later.

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

Pass `outPath` to write the document where `compare_snapshots` can read it later. It is a file name inside the snapshot directory, `SEO_MCP_SNAPSHOT_DIR` or `~/.config/seo-mcp/snapshots` by default; a path that resolves outside that directory or does not end in `.json` is refused, and an existing file is left in place and reported unless you pass `overwrite: true`. A model chooses this string, so the directory is the boundary that keeps a tool call from truncating anything else on the machine. Position and CTR are `null` rather than `0` when a window has no impressions, so an empty window never compares against real data as a collapse.

### `compare_snapshots`

Reads two snapshot documents and reports what changed between them: clicks, impressions and position per property, page-level and query-level movers above an impressions floor, install and rating deltas, App Store version and locale-count changes, the per-locale name, subtitle, keyword, promotional-text and description lengths plus which fields crossed a character limit, Google Play traffic sources by visitors and acquisitions, and the WordPress.org five-star histogram.

```json
{ "from": "2026-08-06.json", "to": "2026-09-03.json", "minImpressions": 100 }
```

`from` and `to` resolve inside the same snapshot directory as `snapshot`'s `outPath`, so this tool reads snapshots and nothing else.

It does arithmetic, never judgement. It will not tell you whether a change was good or what caused it, because a diff cannot support that claim. A surface that failed or is missing on either side is marked not comparable and named, so a collection failure is never read as a change, and a file that is not a snapshot document is refused rather than half-parsed.

Snapshots taken before a field was captured still compare. A field one side does not carry comes back as a `null` delta rather than as a change, and an app pair with no per-locale lengths on either side reports `localesComparable: false` instead of a listing emptied to zero characters.

### `app_store_reviews`

Reads App Store customer reviews and your responses, filtered by star rating or storefront, following Apple's own paging cursor.

```json
{ "bundleId": "com.example.app", "rating": [1, 2], "territory": "USA", "limit": 100 }
```

It reports `meanOfFetched` and `histogramOfFetched`, never "the rating". Those describe only the reviews this call returned, and a filtered or truncated page would make a mean a different number wearing the same name. App Store Connect exposes no aggregate rating resource at all, which is verifiable in Apple's own OpenAPI specification: every path matching "rating" is an *age* rating.

### `app_store_discovery`

Reads the App Store surfaces beyond the listing text: **search keywords** (Apple's actual indexed keyword list, held per locale), app tags, product page optimization experiments, custom product pages, in-app events, territory availability, and review summarizations.

```json
{ "bundleId": "com.example.app", "locales": ["en-US", "ar-SA"], "platform": "IOS" }
```

Each resource carries its own required parameters: `searchKeywords` needs both a platform and a locale filter, `appAvailabilityV2` is a to-one relationship that rejects `limit` outright. A resource this key or app cannot serve is reported as `available: false`, never as an empty list, because "no experiments" and "cannot read experiments" are different answers.

### `crux_field_data`

Real-user Core Web Vitals for an origin or a single URL from the Chrome UX Report: the current 28-day field record, with p75s and full histogram bins.

```json
{ "origin": "https://example.com", "formFactor": "PHONE" }
```

This is field data, not a lab test; keep `pagespeed` for Lighthouse audits. Google is discontinuing PageSpeed's own real-world data, so this is where field measurements move. An origin with too few anonymized samples returns `hasData: false` with a note rather than an error or zeros, since a zeroed LCP would read as a catastrophic regression.

### `crux_history`

The same field metrics as a weekly series, roughly six months of history.

```json
{ "origin": "https://example.com", "formFactor": "PHONE", "collectionPeriodCount": 25 }
```

Each period is a 28-day rolling window stepped weekly, so consecutive points overlap by three weeks and a single week-on-week move is not an independent change. Periods with too few samples keep their place in the series as `null` rather than being dropped, so the values stay aligned with `collectionPeriods`.

### `app_store_sales`

Reads App Store Sales and Trends: units downloaded per day, per territory, per app, summarized by SKU.

```json
{ "reportDate": "2026-08-30", "frequency": "DAILY", "reportType": "SALES", "reportSubType": "SUMMARY" }
```

Set `SEO_MCP_ASC_VENDOR_NUMBER`; App Store Connect shows the vendor number under Payments and Financial Reports, beside the legal entity name. Sales and Trends needs a team key with the Admin, Finance, or Sales and Reports role. Daily reports land the next day, so the default report date is two days back rather than today. `reportDate` takes the shape its frequency needs: `YYYY-MM-DD` for `DAILY` and for `WEEKLY`, where it means the week's ending Sunday, `YYYY-MM` for `MONTHLY`, and `YYYY` for `YEARLY`; leave it out and each frequency defaults to its most recent complete period.

A period with no sales returns `hasData: false` with a note, not an error, because a quiet day should not look like a broken integration. Units come from the Sales and Trends pipeline, which is separate from App Analytics and can disagree with it.

### `play_vitals`

Reads Android vitals from the Play Developer Reporting API: crash rate, ANR rate, error counts and startup metrics, daily or hourly, with optional breakdowns such as `versionCode` or `countryCode`.

```json
{ "packageName": "com.example.app", "metricSets": ["crashRate", "anrRate"], "days": 28 }
```

Set `SEO_MCP_PLAY_CREDENTIALS` to the service account key, falling back to `GOOGLE_APPLICATION_CREDENTIALS`. The account also has to be invited in Play Console under Users and permissions with the permission to view app information and app quality. The token is minted for the `playdeveloperreporting` scope, which is a separate grant from the Cloud Storage read `play_store_stats` needs. One account can hold both, but a key that only has the bucket grant gets a 403 here.

The window is clamped to the freshness the API reports for itself, since it refuses an end date past that and asking through today always fails. The result says how current the data actually is, so zero rows through a known date is distinguishable from zero rows because the day has not landed. This API carries no acquisition or conversion data; `play_store_stats` has that.

## Running a tool from the command line

Every tool above is also runnable without an MCP client, which is what to use when a result has to land in a file that a later run can diff:

```sh
seo-mcp query search_analytics --site-url sc-domain:example.com --start-date 2026-08-05 --out /tmp/sa.json
seo-mcp query --help                  # list the tools
seo-mcp query wporg_plugin --help     # list one tool's parameters
```

Flags are the tool's parameter names in kebab-case (`--site-url` for `siteUrl`); the camelCase spelling works too. List values are comma-separated. The result is written to `--out`, or to stdout when it is omitted, and a failure exits non-zero with the message on stderr. It runs the same implementation the MCP surface exposes, so the two cannot drift.

Tools that change data (`submit_sitemap`, `delete_sitemap`, `request_recrawl`, `indexnow_submit`) are marked `(write)` in the listing and refuse to run from the command line unless `--allow-write` is passed.

## Development

```sh
npm run dev
npm run build
npm test
npm run lint
npx tsc --noEmit
```

Tests use injected fake Google clients and never call live Google services. Do not commit service account keys. In addition to `*.key.json`, this repository ignores `credentials*.json`, `.env*`, PEM files, and P12 files.
