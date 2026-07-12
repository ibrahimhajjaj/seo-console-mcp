# seo-mcp

`seo-mcp` is a stdio [Model Context Protocol](https://modelcontextprotocol.io/) server for Google Search Console, PageSpeed Insights, and on-page SEO audits. It gives MCP clients eleven tools for verified Search Console properties while keeping the HTML audit and PageSpeed tools usable without Google service account credentials.

## Requirements

- Node.js 20.18.1 or newer
- A verified Google Search Console property for the Search Console tools
- A Google Cloud service account added to that property
- `gcloud` only if you use the setup wizard

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

The wizard is safe to rerun. It:

1. Checks for `gcloud`. If it is absent, it prints manual instructions and exits successfully without changing anything.
2. Uses the active authenticated account or runs `gcloud auth login`.
3. Uses the current project, a supplied `--project`, or asks for a project ID. It creates the project if it does not exist and selects it.
4. Enables `searchconsole.googleapis.com`, `pagespeedonline.googleapis.com`, and `siteverification.googleapis.com`.
5. Reuses or creates the `seo-mcp` service account.
6. Reuses an existing key or creates `seo-mcp.key.json`.
7. Prints the required Search Console permission step and ready-to-copy client configurations.

The wizard never prints key contents. The generated `*.key.json` filename is ignored by Git.

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

For example:

```sh
node dist/index.js --credentials /absolute/path/seo-mcp.key.json
```

`pagespeed` is public and does not use the service account. Set `SEO_MCP_PAGESPEED_KEY` or pass `apiKey` to that tool for a higher PageSpeed Insights quota. `seo_audit` also needs no Google credentials.

## Security model

- Verifying a domain makes the service account a **verified Owner**. Owners can change Search Console settings and submit removal (deindex) requests, so treat the key as a sensitive credential even though most tools here only read.
- **Keep the key local.** It lives at the `GOOGLE_APPLICATION_CREDENTIALS` path (`chmod 600` recommended). Never bundle it in a published package, a container image, or a CI secret store. If it leaks, anyone with it has owner control of every verified property.
- **Leave the `google-site-verification` TXT record in DNS.** Google re-checks it; deleting it revokes ownership.
- **No secret is logged.** The wizard and `verify` print credential paths only, never key or token contents.
- **Revoking is easy.** Relinquish ownership from the Search Console UI (or `siteVerification.webResource.delete`), and rotate the key with `gcloud iam service-accounts keys delete`.
- **`seo_audit` only fetches public hosts.** The target URL and every redirect hop is resolved and refused if it lands on a loopback, private, link-local, or other non-public address, so a model cannot be steered into fetching internal services or cloud metadata. The address is validated again at connection time (the socket is pinned to the validated address), so a DNS-rebinding host cannot present a public address at validation and a private one at connect. Set `SEO_MCP_ALLOW_PRIVATE_HOSTS=1` to audit internal or staging hosts you trust. This is not a substitute for network-level isolation; run the server behind egress controls if you audit untrusted URLs on a host with reachable internal services.

## Claude Code

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

## Tools

Every tool validates its input with Zod. Tool failures return an MCP error result instead of terminating the server. Google API status, message, and reason are included when available. A Search Console 403 also explains how to grant the service account property access.

### `list_properties`

Lists every Google Search Console property the service account can access, returning each property's exact `siteUrl` and `permissionLevel`. It takes no input. Service-account credentials are required, unlike `pagespeed` and `seo_audit`.

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

### `inspect_url`

Returns index coverage, verdict, robots state, indexing state, crawl time, fetch state, Google and user canonicals, mobile usability, and rich-result status.

```json
{
  "siteUrl": "sc-domain:example.com",
  "inspectionUrl": "https://www.example.com/products/widget"
}
```

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

## Development

```sh
npm run dev
npm run build
npm test
npm run lint
npx tsc --noEmit
```

Tests use injected fake Google clients and never call live Google services. Do not commit service account keys. In addition to `*.key.json`, this repository ignores `credentials*.json`, `.env*`, PEM files, and P12 files.
