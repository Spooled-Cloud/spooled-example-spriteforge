<p align="center">
  <img src="https://spooled.cloud/logo.webp" alt="Spooled Logo" width="80">
</p>

<h1 align="center">SpriteForge</h1>

<p align="center">
  <strong>Interactive pixel art generator powered by Spooled Cloud</strong>
</p>

<p align="center">
  <a href="https://github.com/spooled-cloud/spooled-example-spriteforge/actions/workflows/ci.yml">
    <img src="https://github.com/spooled-cloud/spooled-example-spriteforge/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="https://github.com/spooled-cloud/spooled-example-spriteforge/pkgs/container/spooled-example-spriteforge">
    <img src="https://img.shields.io/badge/ghcr.io-spooled--example--spriteforge-blue" alt="Docker">
  </a>
  <a href="https://example.spooled.cloud">
    <img src="https://img.shields.io/badge/demo-example.spooled.cloud-brightgreen" alt="Live Demo">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License">
  </a>
</p>

<p align="center">
  <a href="https://example.spooled.cloud">Live Demo</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#deployment">Deployment</a> •
  <a href="#api">API</a>
</p>

---

## What is SpriteForge?

SpriteForge is a **real-time pixel art sprite generator** that demonstrates [Spooled Cloud](https://spooled.cloud) workflows, workers, schedules, retries, and realtime events.

**Releases:** [latest published release](https://github.com/spooled-cloud/spooled-example-spriteforge/releases/latest)

**Try it live:** [example.spooled.cloud](https://example.spooled.cloud)

### Features Demonstrated

| Feature | How It's Used |
|---------|---------------|
| **Workflows (DAG)** | Each sprite is a workflow with parallel frame jobs + dependent assemble job |
| **Workers** | 3 worker types process frames, assemble sprites, and generate public sprites |
| **Realtime + Reconciliation** | Spooled WebSocket events are forwarded to the browser over SSE; scoped polling recovers missed updates |
| **Automatic Retries** | "Chaos mode" simulates transient failures on frame jobs so Spooled retries are visible |
| **Schedules** | "Sprite of the Minute" generated via cron schedule |

---

## Quick Start

### Prerequisites

- Node.js 20+
- A [Spooled Cloud](https://spooled.cloud) API key (or self-hosted Spooled)

### Local Development

```bash
# Clone the repository
git clone https://github.com/spooled-cloud/spooled-example-spriteforge.git
cd spooled-example-spriteforge

# Copy environment template
cp .env.example .env

# Edit .env and add your API key
# SPOOLED_API_KEY=sp_live_your_key_here

# Install dependencies
npm ci

# Load .env into this shell (Node does not auto-load it), then start
set -a
. ./.env
set +a
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Docker

```bash
# Using Docker Compose (recommended)
cp .env.example .env
# Edit .env with your API key

docker compose up --build
```

Or run directly:

```bash
docker run -p 3000:3000 \
  -e SPOOLED_API_KEY=sp_live_your_key \
  ghcr.io/spooled-cloud/spooled-example-spriteforge:<release-tag>
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              SpriteForge                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Browser                     Server                    Spooled Cloud   │
│   ───────                     ──────                    ─────────────   │
│                                                                         │
│   ┌──────────┐  click    ┌──────────────┐  create    ┌──────────────┐   │
│   │   UI     │ ────────► │   Node.js    │  ────────► │   Workflow   │   │
│   └──────────┘           │   Server     │            │   + Jobs     │   │
│        ▲                 └──────────────┘            └──────────────┘   │
│        │                        │                           │           │
│        │ SSE              ┌─────┴─────┐              Workers│           │
│        │                  │           │                     ▼           │
│   ┌────┴─────┐      ┌─────┴───┐ ┌─────┴───┐         ┌──────────────┐    │
│   │  Events  │ ◄─── │ frame   │ │ assemble│ ◄────── │   Process    │    │
│   │  Stream  │      │ worker  │ │ worker  │         │   & Return   │    │
│   └──────────┘      └─────────┘ └─────────┘         └──────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Workflow Structure

When you click "Forge Sprite":

1. **Workflow Created**: A DAG workflow with N+1 jobs
2. **Frame Jobs** (parallel): Each generates one animation frame
3. **Assemble Job** (depends on all frames): Combines frames into sprite
4. **Events Stream**: Job status updates flow to your browser in real-time

```
START ──► [frame-0] [frame-1] [frame-2] ... [frame-N] ──► [assemble] ──► DONE
            │         │         │              │               │
            └─────────┴─────────┴──────────────┘               │
                   all must complete before                    │
                                                               ▼
                                                       sprite rendered
```

---

## Environment Variables

`SPOOLED_API_KEY` is the only variable required by the application. The production Compose stack additionally requires `CLOUDFLARE_TUNNEL_TOKEN`.

See [DEPLOY.md#environment-variables](DEPLOY.md#environment-variables) for the canonical variable table and [.env.example](.env.example) for a copyable template.

---

## Deployment

> 📘 **Full guide**: See [DEPLOY.md](DEPLOY.md) for comprehensive deployment instructions.

### Docker Image

The CI workflow publishes multi-architecture (`linux/amd64`, `linux/arm64`) images to GHCR. Pushes to `main` publish `latest` and a short commit SHA tag; release tags publish the matching version and refresh `latest`:

```text
ghcr.io/spooled-cloud/spooled-example-spriteforge:latest
ghcr.io/spooled-cloud/spooled-example-spriteforge:<short-commit-sha>
ghcr.io/spooled-cloud/spooled-example-spriteforge:<release-tag>
```

### Docker Compose (Production)

The easiest production deployment with Cloudflare Tunnel:

```bash
cp .env.example .env
# Edit .env: add SPOOLED_API_KEY and CLOUDFLARE_TUNNEL_TOKEN

docker compose -f docker-compose.prod.yml up -d
```

This starts:
- **SpriteForge** container (port 3000 internal)
- **Cloudflared** tunnel (secure external access)

### Kubernetes

```bash
# Create secret
kubectl apply -f k8s/base/namespace.yaml
kubectl create secret generic spooled-example-spriteforge-secrets \
  --from-literal=SPOOLED_API_KEY=sp_live_your_key \
  --namespace spooled-example-spriteforge

# Deploy
kubectl apply -k k8s/overlays/production
```

**Included resources:**
- Deployment with liveness/readiness probes
- Service (ClusterIP)
- Ingress (nginx + cert-manager TLS)
- HorizontalPodAutoscaler pinned to one replica (documents the CPU target but does not scale above one)
- PodDisruptionBudget
- ServiceAccount + ConfigMap

### Platform Deployment Starting Points

These are high-level manual starting points, not tested one-click deployments. This repository does not include Railway, Render, or DigitalOcean manifests; confirm each platform's Docker build, start command, health check, port, persistence, and secret settings before calling a deployment production-ready.

| Platform | Starting point |
|----------|----------------|
| **Railway** | Connect the repository, select the Docker build, configure health/port settings, and add `SPOOLED_API_KEY` |
| **Fly.io** | `fly launch` → `fly secrets set SPOOLED_API_KEY=...` → `fly deploy` |
| **Render** | Create a Docker Web Service, configure health/port settings, and add `SPOOLED_API_KEY` |
| **DigitalOcean** | Create an App from GitHub, confirm Docker/health/port settings, and add `SPOOLED_API_KEY` |

---

## API

### Health Check

```
GET /health
```

Returns `200 OK` when the server is healthy.

### Create Sprite (Forge)

```
POST /api/forge
Content-Type: application/json

{
  "sessionId": "uuid",
  "seed": "my-sprite",
  "paletteName": "neon",
  "animation": "walk",
  "frameCount": 8,
  "width": 24,
  "height": 24,
  "failChance": 0.1
}
```

### Event Stream (SSE)

```text
GET /api/events?sessionId=<uuid>
```

Streams realtime events:
- `hello` - connection established; includes palettes, queues, session info, and the latest public sprite
- `ping` - 15-second keepalive
- `spooled` - job lifecycle or global Spooled events
- `public.sprite` - new public sprite generated
- `server.realtime` - server-to-Spooled WebSocket state

### Reconcile Jobs

```text
POST /api/jobs/batch
Content-Type: application/json

{
  "sessionId": "uuid",
  "jobIds": ["job-id"],
  "includeResult": true
}
```

Returns status for at most 50 job IDs already associated with that in-memory session. The browser polls this endpoint while a forge is active to recover updates or results missed by realtime delivery.

---

## Project Structure

```
spooled-example-spriteforge/
├── .github/
│   └── workflows/
│       └── ci.yml              # CI/CD pipeline
├── k8s/
│   ├── base/                   # Base Kubernetes manifests
│   └── overlays/
│       ├── development/        # Dev overrides
│       └── production/         # Prod overrides
├── public/
│   ├── index.html              # Main HTML
│   ├── styles.css              # Styles
│   └── app.js                  # Frontend logic
├── server/
│   ├── server.mjs              # HTTP server + workers
│   └── spriteforge.mjs         # Pixel art generation
├── .env.example                # Environment template
├── Dockerfile                  # Multi-stage Docker build
├── docker-compose.yml          # Local Docker development
├── package.json
└── README.md
```

---

## Development

### Scripts

```bash
npm run dev      # Start the server (same command as npm start; no file watcher)
npm start        # Start production server
```

### Testing Locally with Spooled

You can run against:

1. **Spooled Cloud** (recommended): Sign up at [spooled.cloud](https://spooled.cloud)
2. **Self-hosted Spooled**: See [spooled-backend](https://github.com/spooled-cloud/spooled-backend)

For self-hosted:
```bash
SPOOLED_BASE_URL=http://localhost:8080
SPOOLED_WS_URL=ws://localhost:8080
```

---

## Architecture Notes

### Why One Replica?

The Kubernetes manifests pin both the Deployment and HPA to **one replica**. SSE clients, job-to-session routing, workflow mappings, rate-limit buckets, and the latest public sprite are process-local.

A multi-replica deployment therefore needs more than worker scaling: use sticky sessions for browser requests and move routing/state to shared infrastructure (for example Redis), or split the stateless HTTP frontend from singleton event-routing/schedule responsibilities.

### Job Cleanup (Handling Many Users)

When 100+ users test the demo, jobs and workflows accumulate. SpriteForge handles this automatically:

**1. Job Expiration and Retention**
- Interactive workflow jobs receive an `expiresAt` timestamp 24 hours in the future by default (`JOB_RETENTION_HOURS`).
- The Spooled backend cleanup task runs every five minutes. Explicit expiration removes pending, scheduled, failed, or dead-letter jobs after `expiresAt`; completed/cancelled jobs use organization retention instead.

**2. Workflow Cleanup**
- Completed, failed, or cancelled workflows use organization job-retention limits.
- Current built-in defaults are Free 3 days, Starter 14 days, Pro 30 days, and Enterprise 90 days; organization overrides may change them.

**3. In-Memory Cleanup**
- Session mappings (for routing events) are cleaned every 10 minutes
- Mappings older than 1 hour are automatically removed

**4. Queue Reuse**
- Queues (`spriteforge-frames`, `spriteforge-assemble`, `spriteforge-public`) are reused by all users
- No queue accumulation occurs

> **Tip**: For high-traffic public demos, set `JOB_RETENTION_HOURS=1` in your `.env` file.

**Monitor via health endpoint:**
```bash
curl http://localhost:3000/health
# Returns stats: { activeSessions, trackedJobs, trackedWorkflows, totalWorkflows, totalJobs }
```

### SDK and Security Notes

SpriteForge pins `@spooled/sdk` to the exact SDK version it is tested against in `package.json`; the committed `package-lock.json` records the same exact SDK version reproduced by `npm ci`. Review and record both for each release, but do not force the SDK version to equal the SpriteForge application version. It uses `SpooledClient`, `SpooledWorker`, and WebSocket `SpooledRealtime`; workflows are created with `client.workflows.create()`, dependency results are read with `client.workflows.jobs.getDependencies()` and `client.jobs.get()`, and the public schedule uses `client.schedules`.

When deploying publicly:
- Use a **dedicated Spooled organization** for the demo.
- Set **plan limits** and retain the app’s built-in per-IP request limits.
- Keep `SPOOLED_API_KEY` server-side; the browser only calls SpriteForge endpoints.

---

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) first.

```bash
# Fork the repo, then:
git checkout -b feature/my-feature
# Make changes
git commit -m "feat: add my feature"
git push origin feature/my-feature
# Open a PR
```

---

## License

Apache 2.0 © [Spooled Cloud](https://spooled.cloud)

---

<p align="center">
  Built with ⚡ by <a href="https://spooled.cloud">Spooled Cloud</a>
</p>
