# SpriteForge example — Agent Knowledge Base

Demo app **v1.0.15** using `@spooled/sdk` **1.0.39** (lease fencing on complete/fail/heartbeat). Live: `example.spooled.cloud`.

Entry: `server/server.mjs` — `SpooledClient`, three `SpooledWorker` queues, workflows, schedules, realtime bridge. `/health` returns app version/commit/digest identity; CI bakes `SOURCE_COMMIT` into the image. **Prod compose must not default `SOURCE_COMMIT=unknown`** (clobbers bake — SF-13). Health check runs once at boot, then every 5m.

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

See `DEPLOY.md` for deploy. **Do not pin SDK below 1.0.39** while backend enforces lease_id fencing (see SF-02). `package.json` pins the exact SDK version SpriteForge is tested against. Existing public schedules are updated when cron/timezone/payload changes and recreated when target queue changes. Docker builds must keep local `.env` files out of the build context.
