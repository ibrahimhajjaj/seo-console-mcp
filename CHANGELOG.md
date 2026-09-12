# Changelog

## 0.13.2

### Fixed

- The plugin manifest said 0.9.0 while the package said 0.13.1, and the plugin
  installer reads the manifest. So `claude plugin update` read the stale number,
  compared it to the installed one, found them equal and reported success. It
  went four minor versions stale behind a tick that read as an update, and the
  whole Google Ads surface, twelve tools, was unreachable the entire time.
- The manifest also asked npm for `seo-console-mcp@^0.10.0`, which reads as
  "0.10 and up" and is not: a caret on a 0.x version pins the minor, so that
  range stops below 0.11.0 and would never have installed 0.13.x. Correcting the
  version alone would have looked like a fix and changed nothing. It now asks
  for a range that includes the released version and every later 0.x.
- A test now fails if the two versions disagree or if the range does not include
  the current one. A version kept in several places with only some of them
  automated goes stale the first time someone is in a hurry, and it fails
  quietly, because each file on its own is still valid.

### Changed

- The plugin description and keywords name Google Ads, which has been in the
  package since 0.11.0 and was missing from the text the marketplace shows.

## 0.13.1

### Fixed

- `ads_assets` answered an unknown campaign name with an empty success. A typo
  returned zero rows and no error, beside a note explaining that account-level
  assets are listed even when a campaign is named, so a reader concluded the
  account had none of those either. Absence wore the costume of a result, which
  is the one thing this project is meant not to do. The name is now resolved
  before anything is read and an unknown one is refused by name, because the
  caller who mistypes a campaign is the caller who then says that campaign has
  no sitelinks and acts on it. Found in review against a live account.

### Changed

- `ads_assets` shows an asset's field type only where it differs from its asset
  type. The two are the same word in almost every row, so printing both every
  time buried the rows where the field type is the informative half: a `TEXT`
  asset filed as `BUSINESS_NAME` is described by the second half, not the first,
  and the unshaped summary now names it.

## 0.13.0

Say where a missing Play metric actually lives.

### Fixed

- A `play_vitals` error note cut the API's message at the first period, so
  `/apps/com.mbh.azkari/crashRateMetricSet` printed as `/apps/com` and the note
  threw away the app name at the moment it mattered. A package name, a URL and a
  decimal all carry periods; it now splits on a sentence-ending one.

### Changed

- `play_store_stats` names the five metrics that exist only in Play Console, and
  where each one lives: device first opens, DAU and MAU, 7-day device retention,
  peer benchmarks, and store listing experiment state. No Google API returns
  them, checked at contract level against both the Play Developer Reporting API
  and the Play Android Developer API rather than assumed. A metric that is absent
  with nothing said about it reads as a zero, which is the same mistake this tool
  already had to fix once for unpopulated columns. Store listing visitors,
  acquisitions and conversion rate are NOT in that list: those come from the
  bulk reports and this tool already returns them.

## 0.12.0

Google Ads: read what the ad says and what serves beside it.

### Added

- `ads_ad_copy` reads what an ad actually says. `ads_ads` returns the id,
  strength, approval and status but not the text, so every creative question
  ended in the browser: what does this ad say, why is its strength Poor, is that
  headline duplicated across two ads, did the copy that was supposed to ship
  actually ship. This returns every headline and description with its pinning
  and Google's performance label, the display path, the final URLs, and the
  policy topics behind a limited or disapproved status. The approval word says
  something is wrong; the topic says what. It counts the copy against what
  Google wants, names text repeated inside one ad, and lists headline text used
  by more than one ad, since two ads in an ad group sharing their headlines are
  not two variants being tested against each other. Assets such as sitelinks and
  promotions are not read, and that is said in the output rather than left to be
  inferred from an ad that looks thin.
- `ads_assets` reads the sitelinks, callouts, structured snippets, promotions,
  prices, call and image assets attached at account, campaign and ad group
  level, with what each one says rather than only its type and id: a promotion
  reads back as `up to 20% off on Pro plan with code LAUNCH20`, not as
  `PROMOTION #4417`. Google states a promotion's percentage in millionths where
  1,000,000 is 100%, so the raw field is a number nobody would recognise as a
  discount. An account-level asset applies to every campaign and is listed even
  when one campaign is named, which is the other half of `ads_ad_copy`: an ad
  that looks bare there may be serving with four sitelinks beside it. The three
  levels are three queries, and one that fails is reported in `levelErrors`
  while the other two still return, because an empty list that quietly meant
  the query broke would read as nothing attached. A Money field is selected by its
  `amount_micros` and `currency_code` rather than whole, which is the only
  spelling Google accepts; a repeated message such as `price_offerings` selects
  whole and is left that way.

## 0.11.0

Google Ads: seven reads and three guarded writes.

### Added

- Google Ads, five tools. `ads_campaigns`, `ads_keywords` and `ads_ads` read the
  account through the API; `ads_query` runs an arbitrary GAQL SELECT for a
  question the shaped reads do not cover. A console table pages, so a count taken
  off the first screen can be wrong without looking wrong: a keyword count read
  as two when the answer was five, because the table shows ten rows and there
  were fourteen. These return every row.
- `ads_update` changes one keyword bid, campaign daily budget, campaign status or
  ad status. It is the only tool here that spends money, so it carries four
  rails, each from a real failure rather than a hypothetical. `dryRun` defaults
  to true, so omitting it reports the change and stops; a required parameter
  enforces that better than a flag, because a flag can be forgotten and a default
  cannot. A target must match exactly one thing or nothing is changed. Guards
  refuse more than three times the current amount, more than $25, or pausing
  something that is serving, and the dry run returns the reasons in words so
  `confirm` confirms something already read. After writing, the value is read
  back: an accepted request is not a stored value, and a mismatch comes back as
  an error.
- `ads_search_terms` reads the queries that actually triggered an ad, with the
  keyword and match type each matched, costliest first, with a cost floor and a
  zero-conversions filter so it feeds the negatives tool directly. Sorting by
  impressions would put the cheapest noise at the top of a list whose only
  purpose is deciding what to stop paying for. This is the paid equivalent of the Search Console query
  dimension, and it carries the same caveat: Google withholds terms too few
  people searched, so an absent term is unknown rather than absent.
- `ads_changes` reads the change history: what changed, when, which fields, by
  whom, and whether it came from a tool or from someone in the browser. Google
  keeps 30 days. It is the audit trail for anything `ads_update` writes.
- `ads_update_batch` changes several keyword bids, or several campaign daily
  budgets, in one call. It is a named list of pairs, not a rule applied to many
  things: there is no selector form, because the mistake it exists to prevent is
  the one a pattern makes easy. Every entry resolves before anything is written,
  so a fourth entry that matches nothing does not leave the first three already
  live. The sum is guarded as well as each entry, since five separately
  reasonable raises are one large spend change and making them one at a time is
  how that goes unnoticed. The per-entry ceilings stay flat however long the
  list is, because a typo does not get more acceptable in a bigger batch, but
  the ceiling on the total grows with the batch: a guard that trips on every
  realistic batch is not a guard, it is a checkbox, and once confirm is routine
  it gets passed unread. The total is stated in words whether or not anything
  tripped, the monthly figure both ways for budgets, since the sentence is what
  gets read and the guard is only what stops you when it does not. The one entry
  out of line with the rest is named even when the total is within every
  ceiling: nineteen bids moving cents and one moving $40 is where a typo hides
  in a batch. Two entries cannot name the same thing, including two campaigns
  that share one budget, where the total would count it twice and the second
  write would quietly win. Every value is read back afterwards, entry by entry,
  and the result names the entries that did not store what was sent before the
  ones that did, because on a partial landing the question is which ones, not
  how many.

### Fixed

- The Google Ads reads now say which of their fields are current rather than
  historical. Google keeps no history for a setting, so a date-filtered query
  staples today's value onto an old day's metrics: a campaign paused this
  morning reports PAUSED beside the 1,445 impressions it served last month.
  Status, budget, bid, ad strength and approval are named as current in a note,
  because a number that is true of the window sitting next to one that is not is
  how a reader gets it wrong.

### Changed

- `ads_negatives` reads the negative keywords already in place, at campaign, ad
  group or shared-set level. A negative blocks traffic without leaving a record
  that it did, so it is the list to check when a keyword stops serving and
  nothing looks wrong.
- `ads_negatives_update` adds or removes negatives in a batch, enumerated one by
  one with no pattern form, because "block everything matching X" is one typo
  away from an account-sized mistake. Before adding, every proposed negative is
  checked against the campaign's own live keywords and the batch is refused
  unless confirmed, naming what it would cost: adding `backup` broadly to a
  backup-plugin campaign would block `wordpress backup`, and Google reports no
  error because it is a perfectly valid negative. A wrong bid shows up as spend;
  a wrong negative shows up as nothing. Removals are not collision-checked, since
  removing one can only let traffic through.
- `--allow-spend`, a second CLI gate for tools that cost money. One flag
  authorising both "resubmit a sitemap" and "triple a daily budget" is not a
  gate, so `ads_update` and `ads_update_batch` need both it and `--allow-write`.

## 0.10.0

The total_ store performance report, read properly.

### Fixed

- `play_store_stats` with `storePerformanceTotals` returned zero acquisitions for
  every source, whatever the file said. The two store performance report families
  name their acquisition column differently, and only the per-listing spelling was
  matched, so every row of the total_ family contributed nothing and six months of
  real data came back as 306 acquisitions worth of zeros. The total_ column name is
  recognised now.

### Changed

- `visitors` and `acquisitions` on a traffic source can be `null`. The total_
  family carries no visitor column at all, and reporting an absent column as 0
  is the same failure as reporting an unpopulated one as 0: it invents a
  measurement. A count the report does not carry now comes back as null, with a
  note naming which column is missing and which family carries it.
- `storePerformanceTotals` says what it actually selects. It is a different
  report, not a rollup of the same one: acquisitions only, no visitors, no
  conversion rate, and for some apps far fewer dates with every acquisition
  attributed to a placeholder source. For one real app the two families cover
  the same six months and disagree, 406 against 306, because they are not
  measuring the same thing.

## 0.9.1

A zero the Play reports could not stand behind.

### Fixed

- `play_store_stats` no longer hands back a zero it cannot stand behind. Google
  leaves some installs columns unpopulated per app, and an unpopulated column is
  byte-identical to a measured zero: one real app reports Daily Device
  Uninstalls as 0 on every row of a month in which Uninstall events is 123. Any
  column that is zero on every row of a window with activity elsewhere is now
  left out of `installsWindowTotals` entirely, named in `installsZeroThroughout`,
  and called out in a note beside the sibling column that contradicts it. Taking
  it out of the totals rather than annotating it there is deliberate: a note is
  easy to skim and a zero is easy to quote. The raw value is still in
  `installsLatest` for the last date, so nothing is lost, only moved out of the
  place that reads as a measurement.
- The installs window totals were summing only columns whose name starts with
  Daily, which silently dropped Install events, Update events and Uninstall
  events, and those are the columns that survive when the device counters do
  not. Every per-day column is summed now; the two running totals, Active Device
  Installs and Total User Installs, are still reported only at their last date,
  because adding a stock across days produces a number true of nothing.
- A traffic file with acquisitions but no Play search row no longer reads as
  proof that store search sent nobody. Play collapses sources it does not break
  down into coarse buckets, so the tool now says the count is unattributed, and
  says separately when every row is a placeholder source and the breakdown
  carries no attribution at all.
- The missing-bucket error says that a server reads its environment once at
  startup, so a variable set after the server started needs a restart.

## 0.9.0

Confident wrong answers turned into honest ones, and a snapshot series you can
read back without remembering a filename.

### Added

- Snapshots are a history now rather than two tools and a naming convention the
  caller had to invent. `list_snapshots` says what is on disk, newest first, and
  lists a file that will not parse with its error instead of hiding it;
  `compare_snapshots` takes `latest` and `previous` in `from` and `to`, so the
  comparison everyone actually wants no longer requires knowing two file names;
  and `snapshot` accepts `outPath: "auto"` to name the file after the moment it
  was taken, which is what lets a cron line build a series instead of
  overwriting one file forever. Scheduling stays out: an MCP server should not
  own a daemon, and the README carries the cron line instead.
- `compare_snapshots` now diffs four things the snapshot documents already held
  and the comparison threw away: top queries alongside top pages, the per-locale
  name, subtitle, keyword, promotional-text and description lengths together
  with the fields that crossed a character limit, Google Play traffic sources by
  visitors, acquisitions and conversion rate, and the WordPress.org five-star
  histogram. "Did changing the keyword field move anything" was answerable from
  two files already on disk, and this is retroactive: any pair of snapshots ever
  taken compares on the new fields, and a document from before a field existed
  reports it as a null delta rather than as a change.
- Object-shaped parameters can be given to the command line as JSON.
  `search_analytics --dimension-filter-groups` was advertised in `--help` and
  could not work: the value was split on commas, and the commas are inside it.

### Fixed

- `app_store_sales` could not fetch a monthly or yearly report at all, and every
  refusal from Apple came back as `hasData: false` with a note saying the period
  had no sales. A month with real revenue read as a quiet one. Each frequency
  now takes the date shape it needs, and only a 404 that actually says "no
  sales" is reported as an absence.
- The four insight tools asked for 5,000 rows and never said when there were
  more. Search Console returns rows by clicks, so the cut fell exactly on the
  low-click rows those tools exist to find, and `compare_search_periods` then
  scored a query that had merely slipped below the cut as a total loss of every
  click it used to have. They now report `truncated`, and a key missing from a
  cut-off window counts as unknown rather than zero.
- A gzipped sitemap parsed to zero URLs. `audit_site`, `index_coverage` and
  `request_recrawl` each reported a clean empty result for the `.xml.gz` files
  most large sites publish. Sitemaps are decompressed now, and a document with
  no sitemap root is an error rather than an absence.
- `play_store_stats` silently dropped a `startDate` given without an `endDate`
  and answered for the current month instead, and a reversed window returned
  nulls with no explanation. Both are refused by name, and a window given
  alongside `month` says which one it used.
- The CrUX tools accepted neither or both of `origin` and `url`, then posted an
  empty body or quietly measured the origin. Exactly one is now required.

### Changed

- `snapshot` and `compare_snapshots` only reach files inside one directory,
  `SEO_MCP_SNAPSHOT_DIR` or `~/.config/seo-mcp/snapshots`, and an existing file
  is never replaced without `overwrite`. `outPath` was a string a model chose
  and `snapshot` handed it straight to a truncating write, so a wrong or
  injected path could overwrite anything the server could write. Existing calls
  that passed an absolute path elsewhere need a file name instead.
- `play_vitals` and `app_store_discovery` no longer return their raw rows unless
  asked. Between them they could put a thousand row objects into a caller's
  context in one call, when the row counts and the freshness date already answer
  what was being asked. Pass `includeRows` to get the rows themselves, the same
  switch `app_store_sales` already carries, and the output says when it held rows
  back so a count with no rows beside it cannot be read as empty.
- Independent requests are no longer awaited one at a time. A 13-locale
  `app_store_discovery` run was 19 round trips deep; the metric sets in
  `play_vitals`, the three Search Console reads per property in `snapshot`, the
  two App Store Connect lists behind `app_store_listing`, and the monthly Play
  files now overlap under a bounded pool.
- The Cloudflare API and the Play reporting bucket were the only outbound calls
  with no timeout, so `seo-mcp verify` could hang partway through writing a DNS
  record with nothing to show for it. Both time out, and a Play window is capped
  at 24 months so one call cannot become hundreds of report reads.
- Every tool's parameter table in the README is generated from its schema, with
  a check that fails when the two drift. Roughly twenty shipped parameters were
  undocumented, and the page still said `search_analytics` could not take
  `discover` or `googleNews`. There is also a table of which tools need which
  credentials, and `play_vitals` finally documents the Play Console invite it
  needs, which is a different grant from the bucket access `play_store_stats`
  uses.

### Security

- The refusal to fetch non-public addresses now covers the IPv4 address carried
  inside NAT64, 6to4 and IPv4-compatible IPv6 addresses, along with the reserved,
  benchmarking and multicast ranges. A hostname resolving into one of those
  reached an internal address that the IPv4 rules alone would have refused.
- `undici` moved to 7.29.0 and the lockfile past every remaining advisory, so
  `npm audit` reports nothing on the full tree. undici is the dependency that
  implements the connect-time address pinning, and a test now proves that
  pinning is honored rather than assuming it.

## 0.8.0

Where an App Store number came from, said out loud.

### Changed

- Every rating `app_store_listing` returns now names its `source`, and the tool
  says outright that the number came from the public App Store storefront
  lookup rather than from App Store Connect, whose API has no aggregate rating
  resource at all, only age ratings. Every other field on that tool is read from
  App Store Connect, so a caller was holding two measurements from two pipelines
  that render as the same number. Snapshots taken before the label still parse,
  since refusing them would make recorded history uncomparable.
- The docs no longer claim an App Store Connect key is per app. A team key
  reaches every app on the team; what limits it is the role it was created with,
  and Apple does not allow that role to be changed afterwards, so reading Sales
  and Trends or analytics needs a key created with Admin, Finance, or Sales and
  Reports rather than an upgrade of an App Manager key.

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
