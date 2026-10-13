# SpriteForge example — Agent Knowledge Base

Demo app **v1.0.25** using `@spooled/sdk` **^1.4.1** (lease fencing, draining `worker.stop()`, ack retries, quota 429s not retried). Live: `example.spooled.cloud`.

Entry: `server/server.mjs` — `SpooledClient`, three `SpooledWorker` queues, workflows, schedules, realtime bridge. `/health` returns app version/commit/digest identity; CI bakes `SOURCE_COMMIT` into the image. **Prod compose must not default `SOURCE_COMMIT=unknown`** (clobbers bake — SF-13). Health check runs once at boot, then every 5m. Assemble requires each frame job `result` to be a non-array object with a `pixels` array (`typeof [] === "object"` used to assemble undefined frames — SF-14).

## Frontend (`public/`)

Compact craft UI (2026-07-15 redesign + brand/color pass) **with educational explainers restored below the forge** (2026-07-20):

| Surface   | Role                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Header    | One Spooled mark + SpriteForge title + text “Powered by Spooled” + conn pill + mini stats                 |
| Intro     | Exactly one `<h1>` (page title) + lede                                                                    |
| Hero      | Live canvas stage + forge form (sticky Forge on viewports under 720px)                                    |
| Pipeline  | 5 live steps (`#step-1`…`#step-5`) bound by `app.js`                                                      |
| Tabs      | Jobs (workflow diagram + list) · Events (`#log`) · Minute (`#public`)                                     |
| Learn     | Coffee-shop concept cards (job/queue/worker/workflow/retry/events/schedule/security) + try-it steps     |
| Compare   | Fair alternatives (AWS / BullMQ / Temporal / Inngest) + why Spooled + honest “not always” note            |

Heading outline: `h1` page title → `h2` forge / live (visually hidden) / learn / try / compare / why → `h3` concepts and competitors. Do not reintroduce a heading-less public page.

Stable DOM ids consumed by `app.js` must stay in sync (forge controls, preview/*, jobs, wf-*, log, event-indicator, public, steps, conn-pill, stats, sticky-forge). Also preserve `.tab[data-tab]` and `.pill-text`. Reconcile polling advances pipeline step/status when SSE is partial — copy must not claim “zero polling.”

Icons: true vector `favicon.svg` (~2 KB, from mark), PNG/ICO fallbacks, 192/512 manifest icons. OG/Twitter images use raster `og.webp` (1200×630) — scrapers do not render SVG. Never reintroduce a JPEG-in-SVG favicon.

Visual: craft “pixel forge” with **both** dark and light themes elevated (warm paper light palette, real shadows, forge/brand accent presence — not flat white-on-white). Emerald brand + blue accent + amber pipeline heat. Space Grotesk + JetBrains Mono (async font load); sticky header; stage is hero centrepiece (fills column ≥860px); forge panel top gradient rail; connected pipeline step strip (`#step-1…5` active/completed); section variety — numbered concept rails, try-it playbook, compare matrix rows, why checklist; light via `prefers-color-scheme`; `prefers-reduced-motion` respected. Single brand mark in header. Content max-width ~1180–1240 px.

Demo defaults (from `server/server.mjs` / `docker-compose.prod.yml`): queues `spriteforge-frames|assemble|public`; concurrency 8 / 2 / 1; public cron `0 * * * * *` UTC; forge workflow `maxRetries: 5`.

See `DEPLOY.md` for deploy. **Do not go below SDK 1.3.0** (lease fencing from 1.0.39, see SF-02; drain/ack-retry/quota behaviour from 1.3.0). `package.json` declares `^1.4.1` (lock `1.4.1`); the lockfile holds the exact version. Needs a Starter plan or higher (README "Plan requirements"); SSE streams are capped (`MAX_SSE_CLIENTS` 500, `MAX_SSE_PER_IP` 30: shared NAT). Existing public schedules are updated when cron/timezone/payload changes and recreated when target queue changes. Docker builds must keep local `.env` files out of the build context.

## Workers, health and config (server/)

- `server/worker-supervisor.mjs`: `superviseWorker` starts each worker through a factory (a `SpooledWorker` whose `start()` failed refuses a second start, so every retry is a NEW instance). Transient failures (5xx, timeout, network, circuit breaker) retry with backoff 2 s to 60 s; quota and other 4xx retry every 5 min; the first attempt is awaited, retries run in the background. Worker `error` events go through `createErrorLogLimiter` (first, every 100th, one summary a minute).
- `/health` is `503` / `ok: false` (with `missingWorkers`) until the **frames and assemble** workers run, and `POST /api/forge` answers `503 workers_unavailable` then. The public worker is optional. A Free key therefore shows unhealthy by design.
- Worker ids are a global primary key across organizations: default prefix `spriteforge-<8 hex of sha256(SPOOLED_API_KEY)>` (`WORKER_ID_PREFIX` overrides); a 409 on the id falls back to registering without a `workerId` (logged once per worker).
- `server/guards.mjs` holds the pure helpers (`parseTrustProxy`: false/0/no/off, trimmed, any case = off; `parseIntEnv`: blank = default; `sessionIdProblem`: 400 `missing_session_id` / `invalid_session_id` on `/api/forge` and `/api/jobs/batch`; `featureDisabledInfo`: Free + workflows is relayed as `403 feature_disabled`, not `UNKNOWN_ERROR`).
- The compose files and `k8s/base/configmap.yaml` pass `TRUST_PROXY`, `MAX_SSE_CLIENTS`, `MAX_SSE_PER_IP`, `WORKER_ID_PREFIX` (blank) and `WORKER_SHUTDOWN_TIMEOUT_MS` through; blank means the code default, so a stack that sets none of them behaves as before. Compose sets `stop_grace_period: 30s` (Docker's default is 10 s; the worker drain is 20 s).
- **HTTP surface (`server/server.mjs`, `server/guards.mjs`):** every response gets `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and a `Content-Security-Policy` (`securityHeaders()` / `DEFAULT_CONTENT_SECURITY_POLICY` in `guards.mjs`; `CONTENT_SECURITY_POLICY` env replaces it, `off` sends none; SF-16). The policy is `script-src 'self' https://static.cloudflareinsights.com`, `style-src 'self' https://fonts.googleapis.com`, `font-src 'self' https://fonts.gstatic.com`, `connect-src 'self' https://cloudflareinsights.com` (the Cloudflare Web Analytics beacon the zone injects; SF-18), `frame-ancestors 'none'`, so **`public/` must have no inline `<script>`, `style=` attribute or `on...=` handler** (the Google Fonts `<link data-async-style>` is switched on from `app.js`, Enter in the name field is stopped by a `submit` listener; `test/http.test.mjs` checks this). `HEAD` is routed like `GET` with no body (`/health`, static files, `/api/events` answers the headers without holding a stream slot; SF-15). Static `.webp`/`.webmanifest`/`.txt`/`.xml` have real content types because of `nosniff`. HSTS is the proxy's job. The k8s ingress must not add its own copies of these headers.
- **Image labels (SF-17):** the `Dockerfile` sets `org.opencontainers.image.{title,description,source,url,vendor,licenses,revision,version}` from the `SOURCE_COMMIT` / `APP_VERSION` build args; both CI builds (main and tag) pass them and `docker/metadata-action` labels. `test/release-metadata.test.mjs` guards it.
- `public/log-format.js` builds the Events-log HTML for job keys, job error text and status names with `esc()`; `logLine()` uses innerHTML, so never interpolate server text raw.
