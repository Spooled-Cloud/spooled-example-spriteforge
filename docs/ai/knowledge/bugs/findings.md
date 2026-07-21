# Findings

| ID    | Sev | Summary                                                                                        | Status             |
| ----- | --- | ---------------------------------------------------------------------------------------------- | ------------------ |
| SF-01 | P3  | SDK pin lagged tip — resolved by bump to 1.0.39                                                | closed             |
| SF-02 | P0  | SDK 1.0.26 `completeJob` omitted `leaseId` → backend 0.1.107 `409 LEASE_EXPIRED` → forge hangs | fixed in v1.0.15   |
| SF-03 | P1  | `package-lock.json` app version lagged `package.json` (`1.0.14` vs `1.0.15`)                   | fixed working tree |
| SF-04 | P3  | HTML/manifest referenced missing generated OG/PWA assets                                       | fixed working tree |
| SF-05 | P3  | `/health` lacked app version/commit identity                                                   | fixed working tree |
| SF-06 | P2  | CI/deploy paths did not wire `/health` app commit/digest identity                              | fixed working tree |
| SF-07 | P2  | Existing public schedule ignored cron/timezone/payload/queue config drift                      | fixed working tree |
| SF-08 | P3  | `robots.txt` advertised missing sitemap                                                        | fixed working tree |
| SF-09 | P2  | Docker build context could include local `.env`                                                | fixed working tree |
| SF-10 | P3  | Unused direct deps / stale SDK pin wording / deprecated Kustomize labels                       | fixed working tree |
| SF-11 | P2  | `favicon.svg` was a 949 KB JPEG-in-SVG; only icon + only manifest icon                          | fixed              |
| SF-12 | P2  | Public page had no `<h1>` (only control-panel `<h2>`); SEO/a11y regression                     | fixed              |
| SF-13 | P2  | Prod compose `SOURCE_COMMIT:-unknown` clobbered CI-baked image ENV → live `/health` commit unknown | fixed           |
