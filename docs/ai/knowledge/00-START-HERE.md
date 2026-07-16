# SpriteForge example — Agent Knowledge Base

Demo app **v1.0.15** using `@spooled/sdk` **1.0.39** (lease fencing on complete/fail/heartbeat). Live: `example.spooled.cloud`.

Entry: `server/server.mjs` — `SpooledClient`, three `SpooledWorker` queues, workflows, schedules, realtime bridge. `/health` returns app version/commit/digest identity; CI bakes `SOURCE_COMMIT`, and deploy env may pass `IMAGE_DIGEST`.

## Frontend (`public/`)

Compact craft UI (2026-07-15 redesign + brand/color pass):

| Surface  | Role                                                                                      |
| -------- | ----------------------------------------------------------------------------------------- |
| Header   | One Spooled mark + SpriteForge title + text “Powered by Spooled” + conn pill + mini stats |
| Hero     | Live canvas stage + forge form (sticky Forge on viewports under 720px)                    |
| Pipeline | 5 live steps (`#step-1`…`#step-5`) bound by `app.js`                                      |
| Tabs     | Jobs (workflow diagram + list) · Events (`#log`) · Minute (`#public`)                     |
| Glossary | `<details>` progressive disclosure — not a card wall                                      |

Stable DOM ids consumed by `app.js` must stay in sync (forge controls, preview/_, jobs, wf-_, log, event-indicator, public, steps, conn-pill, stats). Reconcile polling also advances pipeline step/status when SSE is partial.

Visual: slate dark + blue accent (forge CTA matches accent); Space Grotesk + JetBrains Mono; light pixel grid. Single brand mark in header — no duplicate Spooled wordmark logos.

See `DEPLOY.md` for deploy. **Do not pin SDK below 1.0.39** while backend enforces lease_id fencing (see SF-02). Existing public schedules are updated when cron/timezone/payload changes and recreated when target queue changes.
