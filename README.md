<p align="center">
  <img src="https://spooled.cloud/logo.svg" alt="Spooled Logo" width="80">
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
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
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

SpriteForge is a **real-time pixel art sprite generator** that demonstrates the power of [Spooled Cloud](https://spooled.cloud) — a distributed job queue with workflows, real-time events, and automatic retries.

**Try it live:** [example.spooled.cloud](https://example.spooled.cloud)

### Features Demonstrated

| Feature | How It's Used |
|---------|---------------|
| **Workflows (DAG)** | Each sprite is a workflow with parallel frame jobs + dependent assemble job |
| **Workers** | 3 worker types process frames, assemble sprites, and generate public sprites |
| **Real-time Events** | WebSocket events stream job status to browser via SSE |
| **Automatic Retries** | "Chaos mode" simulates failures — watch jobs retry automatically |
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
npm install

# Start the development server
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
  ghcr.io/spooled-cloud/spooled-example-spriteforge:latest
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              SpriteForge                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   Browser                     Server                    Spooled Cloud   │
│   ───────                     ──────                    ─────────────   │
│                                                                          │
│   ┌──────────┐  click    ┌──────────────┐  create    ┌──────────────┐  │
│   │   UI     │ ────────► │   Express    │ ────────► │   Workflow   │  │
│   └──────────┘           │   Server     │            │   + Jobs     │  │
│        ▲                 └──────────────┘            └──────────────┘  │
│        │                        │                           │           │
│        │ SSE              ┌─────┴─────┐              Workers│           │
│        │                  │           │                     ▼           │
│   ┌────┴─────┐      ┌─────┴───┐ ┌─────┴───┐         ┌──────────────┐  │
│   │  Events  │ ◄─── │ frame   │ │ assemble│ ◄────── │   Process    │  │
│   │  Stream  │      │ worker  │ │ worker  │         │   & Return   │  │
│   └──────────┘      └─────────┘ └─────────┘         └──────────────┘  │
│                                                                          │
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
              │         │         │              │              │
              └─────────┴─────────┴──────────────┘              │
                     all must complete before                    │
                                                                 ▼
                                                          sprite rendered
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SPOOLED_API_KEY` | Your Spooled API key |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `SPOOLED_BASE_URL` | `https://api.spooled.cloud` | Spooled REST API URL |
| `SPOOLED_WS_URL` | `wss://api.spooled.cloud` | Spooled WebSocket URL |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `QUEUE_FRAMES` | `spriteforge-frames` | Frame processing queue |
| `QUEUE_ASSEMBLE` | `spriteforge-assemble` | Sprite assembly queue |
| `QUEUE_PUBLIC` | `spriteforge-public` | Public sprite queue |
| `WORKER_CONCURRENCY_FRAMES` | `8` | Concurrent frame jobs |
| `WORKER_CONCURRENCY_ASSEMBLE` | `2` | Concurrent assemble jobs |
| `ENABLE_PUBLIC_SCHEDULE` | `true` | Enable "Sprite of the Minute" |
| `PUBLIC_SCHEDULE_CRON` | `0 * * * * *` | Cron for public sprites |
| `PUBLIC_SCHEDULE_TIMEZONE` | `UTC` | Timezone for schedule |
| `JOB_RETENTION_HOURS` | `24` | Auto-expire jobs after N hours |

See [.env.example](.env.example) for a complete template.

---

## Deployment

> 📘 **Full guide**: See [DEPLOY.md](DEPLOY.md) for comprehensive deployment instructions.

### Docker Image

Built and pushed to GHCR on every push to `main`:

```
ghcr.io/spooled-cloud/spooled-example-spriteforge:latest
ghcr.io/spooled-cloud/spooled-example-spriteforge:sha-<commit>
ghcr.io/spooled-cloud/spooled-example-spriteforge:v1.0.0  # tagged releases
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
kubectl create secret generic spriteforge-secrets \
  --from-literal=SPOOLED_API_KEY=sp_live_your_key \
  -n spriteforge

# Deploy
kubectl apply -k k8s/overlays/production
```

**Included resources:**
- Deployment with liveness/readiness probes
- Service (ClusterIP)
- Ingress (nginx + cert-manager TLS)
- HorizontalPodAutoscaler
- PodDisruptionBudget
- ServiceAccount + ConfigMap

### Platform Quick Deploy

| Platform | Steps |
|----------|-------|
| **Railway** | Fork repo → New project → Connect GitHub → Add `SPOOLED_API_KEY` → Deploy |
| **Fly.io** | `fly launch` → `fly secrets set SPOOLED_API_KEY=...` → `fly deploy` |
| **Render** | New Web Service → Docker → Add `SPOOLED_API_KEY` → Deploy |
| **DigitalOcean** | New App → GitHub → Auto-detect Docker → Deploy |

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

```
GET /api/events?sessionId=<uuid>
```

Streams real-time events:
- `hello` - Connection established, includes palettes and session info
- `spooled` - Job lifecycle events (created, started, completed, failed)
- `public.sprite` - New public sprite generated
- `server.realtime` - Server's connection to Spooled status

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
│   ├── server.mjs              # Express server + workers
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
npm run dev      # Start development server with hot reload
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

The demo runs as **1 replica by default** because:
- SSE connections are stateful
- Session events route to the correct client
- No additional infrastructure (Redis for sessions) required

For multi-replica deployment, you'd need:
- Sticky sessions (ingress annotation)
- Or shared session store (Redis)

### Job Cleanup (Handling Many Users)

When 100+ users test the demo, jobs and workflows accumulate. SpriteForge handles this automatically:

**1. Job Expiration (Auto-cleanup)**
- All demo jobs have `expires_at` set to 24 hours (configurable via `JOB_RETENTION_HOURS`)
- Spooled backend automatically removes expired jobs every 30 seconds

**2. Workflow Cleanup**
- Completed/failed workflows are cleaned based on plan tier retention
- Free tier: 3 days, Starter: 14 days, Pro: 30 days, Enterprise: 90 days

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

### Security Considerations

When deploying publicly:
- Use a **dedicated Spooled organization** for the demo
- Set **plan limits** to prevent abuse
- The API key is stored server-side; never exposed to browsers

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

MIT © [Spooled Cloud](https://spooled.cloud)

---

<p align="center">
  Built with ⚡ by <a href="https://spooled.cloud">Spooled Cloud</a>
</p>
