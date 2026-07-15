# SpriteForge example — Agent Knowledge Base

Demo app **v1.0.14** using `@spooled/sdk` (declared `^1.0.26`, lock **1.0.26**). Live: `example.spooled.cloud`.

Entry: `server/server.mjs` — `SpooledClient`, three `SpooledWorker` queues, workflows, schedules, realtime bridge.

## Frontend (`public/`)

Compact craft UI (2026-07-15 redesign):

| Surface | Role |
|---------|------|
| Header | Brand + Spooled link + conn pill + mini stats |
| Hero | Live canvas stage + forge form (sticky Forge on viewports under 720px) |
| Pipeline | 5 live steps (`#step-1`…`#step-5`) bound by `app.js` |
| Tabs | Jobs (workflow diagram + list) · Events (`#log`) · Minute (`#public`) |
| Glossary | `<details>` progressive disclosure — not a card wall |

Stable DOM ids consumed by `app.js` must stay in sync (forge controls, preview/*, jobs, wf-*, log, event-indicator, public, steps, conn-pill, stats). Reconcile polling also advances pipeline step/status when SSE is partial.

Visual: dark oklch green family (related to Spooled marketing accents) + amber forge accent; Space Grotesk + JetBrains Mono; pixel grid atmosphere. No welcome/comparison essay blocks.

See `DEPLOY.md` for deploy. SDK pin may intentionally lag Node tip — record review date if bumped.
