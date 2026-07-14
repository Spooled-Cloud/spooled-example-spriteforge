# SpriteForge Deployment Guide

This guide covers deploying SpriteForge to production. Choose the method that fits your infrastructure.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Docker Compose (Production)](#docker-compose-production)
3. [Kubernetes](#kubernetes)
4. [Platform Deployments](#platform-deployments)
5. [Cloudflare Tunnel Setup](#cloudflare-tunnel-setup)
6. [Environment Variables](#environment-variables)
7. [Release and Deployment Evidence](#release-and-deployment-evidence)
8. [Health Checks & Monitoring](#health-checks--monitoring)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required

- **Spooled API Key**: Get one from [dashboard.spooled.cloud](https://dashboard.spooled.cloud)
- **Docker** (for container deployments)
- **Cloudflare Tunnel Token** (only when using `docker-compose.prod.yml` with its bundled tunnel)

### Recommended

- Dedicated Spooled organization for the demo
- Plan limits to prevent abuse on public deployment
- If you also self-host the Spooled **backend**, use that repo’s `docker-compose.prod.yml` — gRPC TLS and Prometheus/Grafana bootstrap automatically (no busybox Exited-0 init containers). Production Compose defaults to `:latest` for easy Portainer **Pull and redeploy**. See `spooled-backend/docs/guides/deployment.md` (**Zero-touch init**) and `spooled-backend/docs/guides/production-host-portainer.md`.

---

## Docker Compose (Production)

The simplest production deployment uses `docker-compose.prod.yml` with Cloudflare Tunnel.

### 1. Clone and Configure

```bash
git clone https://github.com/spooled-cloud/spooled-example-spriteforge.git
cd spooled-example-spriteforge

# Copy environment template
cp .env.example .env
```

### 2. Edit `.env`

```bash
# Required
SPOOLED_API_KEY=sp_live_your_key_here
CLOUDFLARE_TUNNEL_TOKEN=your_tunnel_token

# Optional overrides
SPOOLED_BASE_URL=https://api.spooled.cloud
SPOOLED_WS_URL=wss://api.spooled.cloud
```

### 3. Deploy

```bash
docker compose -f docker-compose.prod.yml up -d

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Check status
docker compose -f docker-compose.prod.yml ps
```

### 4. Configure Cloudflare Tunnel

In Cloudflare Zero Trust dashboard:
1. Go to **Networks → Tunnels**
2. Find your tunnel
3. Add public hostname: `example.spooled.cloud`
4. Service: `http://spriteforge:3000`

---

## Kubernetes

Kubernetes manifests using Kustomize, with probes, resource limits, ingress/TLS integration, a PodDisruptionBudget, and a deliberately single-replica HPA.

### Directory Structure

```
k8s/
├── base/
│   ├── configmap.yaml
│   ├── deployment.yaml
│   ├── hpa.yaml
│   ├── ingress.yaml
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── pdb.yaml
│   ├── secrets.yaml.template
│   ├── service.yaml
│   └── serviceaccount.yaml
└── overlays/
    ├── development/
    │   └── kustomization.yaml
    └── production/
        └── kustomization.yaml
```

### 1. Create Namespace and Secret

```bash
# Create namespace
kubectl apply -f k8s/base/namespace.yaml

# Create the secret referenced by the Deployment
kubectl create secret generic spooled-example-spriteforge-secrets \
  --from-literal=SPOOLED_API_KEY=sp_live_your_key \
  --namespace spooled-example-spriteforge
```

### 2. Deploy Production Overlay

```bash
# Preview what will be applied
kubectl apply -k k8s/overlays/production --dry-run=client -o yaml

# Apply
kubectl apply -k k8s/overlays/production

# Check rollout
kubectl rollout status deployment/spooled-example-spriteforge \
  --namespace spooled-example-spriteforge
```

### 3. Verify Deployment

```bash
# Check pods
kubectl get pods --namespace spooled-example-spriteforge

# Check service
kubectl get svc --namespace spooled-example-spriteforge

# Check ingress
kubectl get ingress --namespace spooled-example-spriteforge

# View logs
kubectl logs -f deployment/spooled-example-spriteforge \
  --namespace spooled-example-spriteforge
```

### 4. DNS & TLS

The included Ingress manifest expects:
- **nginx ingress controller**
- **cert-manager** with a `letsencrypt-prod` ClusterIssuer
- DNS A/CNAME record pointing `example.spooled.cloud` to your ingress

The production overlay intentionally remains at one replica: both the Deployment and HPA are pinned to `1`. The application keeps SSE clients and job/session routing in process memory, so raising the replica count without sticky routing and shared state can lose or misroute updates.

---

## Platform Deployments

### Railway

1. Fork this repository
2. Create new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add environment variable: `SPOOLED_API_KEY`
5. Deploy!

Railway will auto-detect the Dockerfile and deploy.

### Fly.io

```bash
# Install flyctl if needed
# brew install flyctl

# Login
fly auth login

# Launch (creates app, doesn't deploy yet)
fly launch --name spriteforge --no-deploy

# Set secrets
fly secrets set SPOOLED_API_KEY=sp_live_your_key

# Deploy
fly deploy
```

### Render

1. Create new Web Service on [Render](https://render.com)
2. Connect your GitHub repo
3. Select "Docker" as environment
4. Add environment variable: `SPOOLED_API_KEY`
5. Deploy!

### DigitalOcean App Platform

1. Create new App on [DigitalOcean](https://cloud.digitalocean.com/apps)
2. Connect your GitHub repo
3. Auto-detect Dockerfile
4. Add environment variable: `SPOOLED_API_KEY`
5. Deploy!

---

## Cloudflare Tunnel Setup

Cloudflare Tunnel provides secure, zero-trust access without exposing ports.

### 1. Create Tunnel

In [Cloudflare Zero Trust](https://one.dash.cloudflare.com):

1. Go to **Networks → Tunnels**
2. Click **Create a tunnel**
3. Name: `spriteforge`
4. Copy the tunnel token

### 2. Configure Public Hostname

1. In your tunnel config, click **Public Hostnames**
2. Add hostname:
   - **Subdomain**: `example`
   - **Domain**: `spooled.cloud`
   - **Service**: `http://spriteforge:3000`
3. Save

### 3. Add Token to Environment

```bash
# In .env
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiNTM...your_token
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SPOOLED_API_KEY` | Your Spooled API key |

### Optional - Spooled Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `SPOOLED_BASE_URL` | `https://api.spooled.cloud` | Spooled REST API |
| `SPOOLED_WS_URL` | `wss://api.spooled.cloud` | Spooled WebSocket |
| `DEBUG` | unset | Set to `true` for SDK debug logging |

### Optional - Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | unset by the app | Runtime environment; Docker/Compose/Kubernetes set `production` |

### Optional - Queues

| Variable | Default |
|----------|---------|
| `QUEUE_FRAMES` | `spriteforge-frames` |
| `QUEUE_ASSEMBLE` | `spriteforge-assemble` |
| `QUEUE_PUBLIC` | `spriteforge-public` |

### Optional - Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CONCURRENCY_FRAMES` | `8` | Concurrent frame jobs |
| `WORKER_CONCURRENCY_ASSEMBLE` | `2` | Concurrent assemble jobs |
| `WORKER_CONCURRENCY_PUBLIC` | `1` | Concurrent scheduled public-sprite jobs |

### Optional - Schedule

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_PUBLIC_SCHEDULE` | `true` | Enable "Sprite of the Minute" |
| `PUBLIC_SCHEDULE_NAME` | `spriteforge-public-sprite` | Idempotent schedule lookup name |
| `PUBLIC_SCHEDULE_CRON` | `0 * * * * *` | Six-field cron expression (every minute) |
| `PUBLIC_SCHEDULE_TIMEZONE` | `UTC` | Timezone |

### Optional - Cleanup

| Variable | Default | Description |
|----------|---------|-------------|
| `JOB_RETENTION_HOURS` | `24` | Hours until interactive workflow jobs reach their explicit expiration |

### Optional - Production Compose

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFLARE_TUNNEL_TOKEN` | none | Required by `docker-compose.prod.yml` for the bundled tunnel |
| `SPRITEFORGE_IMAGE` | `ghcr.io/spooled-cloud/spooled-example-spriteforge:latest` | Image override for production Compose |

> **Retention note:** SpriteForge sets `expiresAt` on interactive workflow jobs. The Spooled backend checks cleanup every five minutes; pending, scheduled, failed, and dead-letter jobs can be removed after explicit expiration, while completed/cancelled jobs and completed/failed/cancelled workflows follow organization retention limits.

---

## Release and Deployment Evidence

### Version and compatibility surfaces

A SpriteForge application release has three root version fields that must agree:

- `package.json.version` — the authoritative application source/release version.
- top-level `package-lock.json.version` — generated npm lock metadata.
- `package-lock.json.packages[""].version` — generated metadata for the root package.

Use `npm version <version> --no-git-tag-version` to update the three application fields together. A `v*` release tag must equal these values after removing its `v` prefix. The tag-only CI guard enforces that relationship before the release job can publish an image or GitHub Release.

Release-facing documentation and image examples are additional review surfaces, not authoritative version sources. Prefer version-neutral links and placeholders such as the GitHub latest-release page and `ghcr.io/spooled-cloud/spooled-example-spriteforge:<release-tag>`. If a concrete current version is intentionally documented, include it in the release review so it cannot silently lag the tag.

`@spooled/sdk` has different semantics from the SpriteForge application version:

- `package.json` declares the compatible SDK semver range.
- `package-lock.json` records the exact SDK package resolved and reproduced by `npm ci`.

The range and lock resolution are intentional compatibility state. At the current documented state, `package.json` declares `^1.0.26` and `package-lock.json` resolves `@spooled/sdk` to exactly `1.0.26`; `npm ci` reproduces that resolution. Review both, record the locked SDK version and relevant integration evidence, and decide whether an update is needed. The SDK version is **not** required to equal the SpriteForge application version, and a release must not update it merely to create numerical equality.

### CI and image publication model

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and `v*` tag pushes:

- `check` installs with `npm ci`, runs the tag-only application-version assertion when applicable, and checks server JavaScript syntax.
- Main pushes that pass `check` publish multi-architecture `linux/amd64` and `linux/arm64` images tagged `latest` and with the short source commit SHA.
- Tag pushes that pass `check` publish the literal release tag, refresh `latest`, and create a GitHub Release.
- The filesystem Trivy scan is currently non-blocking (`exit-code: 0`) and should be recorded as such rather than described as a release gate.

Main publication remains independent of the tag-only assertion. A workflow run and GHCR image prove artifact publication, not deployment to `example.spooled.cloud`, Docker Compose, Kubernetes, or another platform.

### Advisory release and deployment checklist

This checklist is advisory evidence tracking. Items may be marked `N/A`, or an exception may be recorded with an owner and rationale; it does not authorize or itself block research builds. A mismatch among the tag and application package/lock fields for the same release artifact is a release error and cannot be waived for tag publication.

#### Prepare and validate the release

- [ ] Record `RELEASE_VERSION`, `RELEASE_TAG=v${RELEASE_VERSION}`, the intended branch, and the exact source commit; confirm the tag is unused and the working tree is clean and synced.
- [ ] Update `package.json.version`, top-level `package-lock.json.version`, and `package-lock.json.packages[""].version` together.
- [ ] Search README, deployment guidance, image examples, and release links for stale concrete application versions.
- [ ] Record the declared `@spooled/sdk` range and exact lock resolution; review SDK release notes and compatibility relevant to workers, workflows, schedules, REST, and realtime usage.
- [ ] Do not require the SDK and application versions to match numerically; record why the locked SDK is retained or changed.
- [ ] Run `npm ci` and `node --check server/server.mjs server/spriteforge.mjs`.
- [ ] Build the Docker image and verify its health check locally when Docker is available.
- [ ] Confirm no secret-bearing `.env` file or generated local artifact is staged.

#### Publish and identify the artifact

- [ ] Create the tag on the validated commit and confirm `git rev-parse "${RELEASE_TAG}^{}"` resolves to that commit.
- [ ] Record the successful CI/release workflow and GitHub Release URL.
- [ ] Confirm both architecture images and the multi-architecture `ghcr.io/spooled-cloud/spooled-example-spriteforge:${RELEASE_TAG}` manifest exist.
- [ ] Record the immutable GHCR digest. Do not use mutable `latest` as release identity.
- [ ] Confirm source commit, application version, Git tag, GitHub Release, image tag, and digest describe the same artifact.

#### Deploy separately

- [ ] Record the target environment/platform, operator/provider deployment ID, time, selected immutable tag or digest, and previous rollback artifact.
- [ ] Override `SPRITEFORGE_IMAGE` or the Kustomize image to the recorded immutable tag/digest rather than relying on the checked-in `latest` default.
- [ ] Confirm the actual container or Kubernetes workload resolves to the intended digest and record rollout history.
- [ ] Do not infer deployment from a successful tag workflow, GitHub Release, or GHCR package page.

#### Verify health and end-to-end behavior

- [ ] Call the deployed `GET /health`; require `200` and inspect API/circuit-breaker status plus session/job/workflow counters.
- [ ] Treat `/health` as service-health evidence, not release-version or digest proof; connect live state to the artifact using platform/deployment provenance.
- [ ] Load the public UI in a clean browser session and check console/network errors.
- [ ] Using a dedicated Spooled organization, forge a sprite and verify workflow creation, frame processing, assembly, and rendered output.
- [ ] Verify SSE event delivery and `POST /api/jobs/batch` reconciliation so a result can recover after missed realtime events.
- [ ] If enabled, verify the public schedule and latest-public-sprite path without modifying unrelated organizations.
- [ ] Record the deployed app commit/digest, backend environment, declared and locked SDK versions, observation time, and any blocked path.
- [ ] Clean up isolated test resources and do not claim live verification from source, tag, or health evidence alone.

#### Rollback

- [ ] Record the last known-good immutable image digest before deployment.
- [ ] Reconfigure Compose, Kubernetes, or the hosting provider to that digest/tag and verify rollout completion.
- [ ] Repeat health, UI, forge workflow, SSE/reconciliation, and backend-connectivity checks.
- [ ] Record rollback operator, time, reason, deployment ID, image digest, and verification evidence.

## Health Checks & Monitoring

### Health Endpoint

```bash
curl http://localhost:3000/health
# Returns 200 while fewer than three consecutive periodic Spooled API checks have failed.
# The JSON includes API/circuit-breaker status plus session, job, workflow, and cleanup counters.
```

### Docker Health Check

The container includes a built-in health check:
- Interval: 30s
- Timeout: 10s
- Retries: 3
- Start period: 10s

### Kubernetes Probes

The deployment includes:
- **Liveness probe**: `/health`
- **Readiness probe**: `/health`

### Logs

```bash
# Docker
docker compose logs -f spriteforge

# Kubernetes
kubectl logs -f deployment/spooled-example-spriteforge \
  --namespace spooled-example-spriteforge

# Fly.io
fly logs
```

---

## Troubleshooting

### Container won't start

1. Confirm `SPOOLED_API_KEY` is defined without printing its value (for example, `test -n "$SPOOLED_API_KEY"`).
2. Check Spooled is reachable: `curl https://api.spooled.cloud/health`.
3. View container logs.

### No real-time events

1. Verify `SPOOLED_WS_URL` is correct.
2. Check server logs for the Spooled WebSocket state and browser diagnostics for the SpriteForge SSE connection.
3. Confirm `POST /api/jobs/batch` succeeds; the browser uses scoped polling to reconcile updates missed by realtime delivery.

### Cloudflare Tunnel not connecting

1. Verify tunnel token is correct
2. Check tunnel status in Zero Trust dashboard
3. Ensure public hostname is configured

### High memory usage

1. Reduce worker concurrency
2. Add resource limits in Docker/K8s

### Sprite generation slow

1. Increase `WORKER_CONCURRENCY_FRAMES`
2. Check Spooled API latency
3. Verify no rate limiting

---

## Security Considerations

1. **API Key**: Never expose in browser; stays server-side
2. **Dedicated Org**: Use separate organization for public demo
3. **Plan Limits**: Set job/workflow limits to prevent abuse
4. **Rate Limiting**: The app has in-memory per-IP limits for forge and reconciliation requests; add reverse-proxy limits for stronger or multi-replica enforcement.

---

## Support

- [GitHub Issues](https://github.com/spooled-cloud/spooled-example-spriteforge/issues)
- [Spooled Documentation](https://spooled.cloud/docs)
- [Spooled Discord](https://discord.gg/spooled)
