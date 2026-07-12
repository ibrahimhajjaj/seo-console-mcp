---
description: Pre-launch / launch SEO readiness check (go/no-go)
argument-hint: "[siteUrl e.g. sc-domain:example.com]"
---

Run a launch or pre-launch SEO readiness check for the Search Console property `$ARGUMENTS`.

1. Run `seo_audit` and `pagespeed` on the key pages (start with the homepage).
2. Run `index_coverage` on the sitemap (or `inspect_url` on a specific page) to confirm Google can index the pages.
3. Run `list_sitemaps` to confirm a sitemap is submitted; if it is missing, offer to run `submit_sitemap`.

Output a go/no-go checklist covering technical and indexing readiness (titles, meta, canonical, headings, speed, indexable, sitemap submitted). Remember that search-analytics data will not exist yet at launch, so do not expect ranking insights; the goal is a clean, indexable, fast foundation so the site is ready to capture traffic as it arrives.
