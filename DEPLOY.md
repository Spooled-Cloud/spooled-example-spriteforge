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

### Plan requirements

A **Starter plan or higher** is required: 3 workers (Free allows 1), 3 queues (Free allows 2), workflows (Free: disabled, Starter: 5 pending or running at the same time) and up to 13 active jobs per Forge (Free allows 10 active jobs, Starter 500). On Free the app still boots and serves `/`, but only one worker registers (`/health` lists the others under `workers`), so `/health` answers `503` and Forge answers `503 workers_unavailable`; when the workers do run but the plan has no workflows (Free), Forge answers `403 feature_disabled` ("workflows is not available on the Free plan"), relayed as such. The container health check, Compose and the Kubernetes probes all use `/health`, so a Free key shows as unhealthy. On Starter the workflows limit counts workflows that are pending or running, so a sixth simultaneous Forge gets `429 QUOTA_EXCEEDED` until one finishes. The default public schedule (every minute) alone is 1,440 jobs/day, above the Free 1,000/day and a large share of Starter's 10,000/day; set `ENABLE_PUBLIC_SCHEDULE=false` to save the budget. See the README "Plan requirements" table.

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

| Variable          | Description          |
| ----------------- | -------------------- |
| `SPOOLED_API_KEY` | Your Spooled API key |

### Optional - Spooled Connection

| Variable           | Default                     | Description                         |
| ------------------ | --------------------------- | ----------------------------------- |
| `SPOOLED_BASE_URL` | `https://api.spooled.cloud` | Spooled REST API                    |
| `SPOOLED_WS_URL`   | `wss://api.spooled.cloud`   | Spooled WebSocket                   |
| `DEBUG`            | unset                       | Set to `true` for SDK debug logging |

### Optional - Server

| Variable   | Default          | Description                                                     |
| ---------- | ---------------- | --------------------------------------------------------------- |
| `PORT`     | `3000`           | HTTP port                                                       |
| `HOST`     | `0.0.0.0`        | Bind address                                                    |
| `NODE_ENV` | unset by the app | Runtime environment; Docker/Compose/Kubernetes set `production` |

### Optional - Queues

| Variable         | Default                |
| ---------------- | ---------------------- |
| `QUEUE_FRAMES`   | `spriteforge-frames`   |
| `QUEUE_ASSEMBLE` | `spriteforge-assemble` |
| `QUEUE_PUBLIC`   | `spriteforge-public`   |

### Optional - Workers

| Variable                      | Default | Description                             |
| ----------------------------- | ------- | --------------------------------------- |
| `WORKER_CONCURRENCY_FRAMES`   | `8`     | Concurrent frame jobs                   |
| `WORKER_CONCURRENCY_ASSEMBLE` | `2`     | Concurrent assemble jobs                |
| `WORKER_CONCURRENCY_PUBLIC`   | `1`     | Concurrent scheduled public-sprite jobs |

### Optional - Workers, live connections and proxy

The Compose files and the Kubernetes ConfigMap pass these through; a blank (or unset) value means the default below.

| Variable                     | Default       | Description                                                                                          |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `WORKER_ID_PREFIX`           | `spriteforge-<8 hex of sha256(SPOOLED_API_KEY)>` | Stable worker ids `<prefix>-frames/-assemble/-public`; one replica per prefix. Worker ids are global across organizations, so leave it blank unless you need a fixed name (on a `409` the worker registers without an id) |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `20000`       | How long SIGTERM lets running jobs finish before they are aborted and failed; Compose sets `stop_grace_period: 30s` (Docker's default is 10 s)  |
| `MAX_SSE_CLIENTS`            | `500`         | Max concurrent `/api/events` streams per process (503 `sse_capacity`)                                |
| `MAX_SSE_PER_IP`             | `30`          | Max concurrent `/api/events` streams per client IP (429 `sse_per_ip_limit`); generous because many visitors share one NAT address |
| `TRUST_PROXY`                | `true`        | Trust `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for`; `false`, `0`, `no` or `off` if the port is exposed directly |

### Optional - Security headers

Every response (the UI, `/health`, API errors, the event stream) carries `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that switches off camera, microphone, geolocation, payment and USB, and a `Content-Security-Policy`. The default policy allows this origin plus the Google Fonts stylesheet and font files and the Cloudflare Web Analytics beacon (`static.cloudflareinsights.com` script, reports to `cloudflareinsights.com`) that a Cloudflare zone may inject at the edge, allows no inline script or style, and forbids framing (`frame-ancestors 'none'`). The app does not send HSTS (it also serves plain HTTP in development); set that at the proxy or Cloudflare.

| Variable                  | Default                  | Description                                                                                                                         |
| ------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CONTENT_SECURITY_POLICY` | *(the policy above)*     | Blank keeps the default. `off` (also `false`, `0`, `no`, `none`) sends no policy, for a proxy in front that sets its own. Any other value replaces the default; a policy that blocks the page's own script, stylesheet or event stream breaks the UI. The Compose files and the Kubernetes ConfigMap pass it through. |

The Kubernetes ingress no longer adds its own copy of these headers (it used to send `X-Frame-Options: SAMEORIGIN`, which would conflict with the app's `DENY`).

### Optional - Schedule

| Variable                   | Default                     | Description                              |
| -------------------------- | --------------------------- | ---------------------------------------- |
| `ENABLE_PUBLIC_SCHEDULE`   | `true`                      | Enable "Sprite of the Minute"            |
| `PUBLIC_SCHEDULE_NAME`     | `spriteforge-public-sprite` | Idempotent schedule lookup name          |
| `PUBLIC_SCHEDULE_CRON`     | `0 * * * * *`               | Six-field cron expression (every minute) |
| `PUBLIC_SCHEDULE_TIMEZONE` | `UTC`                       | Timezone                                 |

### Optional - Cleanup

| Variable              | Default | Description                                                           |
| --------------------- | ------- | --------------------------------------------------------------------- |
| `JOB_RETENTION_HOURS` | `24`    | Hours until interactive workflow jobs reach their explicit expiration |

### Optional - Production Compose

| Variable                  | Default                                                    | Description                                                                                                |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_TUNNEL_TOKEN` | none                                                       | Required by `docker-compose.prod.yml` for the bundled tunnel                                               |
| `SPRITEFORGE_IMAGE`       | `ghcr.io/spooled-cloud/spooled-example-spriteforge:latest` | Image override for production Compose                                                                      |
| `SOURCE_COMMIT`           | *(image bake)*                                             | Optional override for `/health` `app.commit`. **Omit in Portainer** so the CI-baked image `ENV SOURCE_COMMIT` wins. Do not default compose to `unknown` — that clobbers the bake. |
| `IMAGE_DIGEST`            | empty                                                      | Optional immutable digest for `/health` `app.imageDigest` after deploy tooling resolves it. Omit unless set intentionally. |

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

- `package.json` declares the SDK range SpriteForge is tested against.
- `package-lock.json` records the exact SDK package resolved and reproduced by `npm ci`.

At the current documented state, `package.json` declares `@spooled/sdk` as `^1.4.0` and `package-lock.json` resolves the SDK to exactly `1.4.0` (since SpriteForge `1.0.23`); `npm ci` reproduces that resolution. Do not go below `1.3.0`: it drains workers on `stop()`, retries acks, never retries plan-quota 429s and keeps the realtime JWT off the REST bearer. `1.4.0` adds that per-second rate-limit 429s no longer open the client's circuit breaker. The SDK version is **not** required to equal the SpriteForge application version, and a release must not update it merely to create numerical equality.

### CI and image publication model

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and `v*` tag pushes:

- `check` installs with `npm ci`, runs the tag-only application-version assertion when applicable, and checks server JavaScript syntax.
- Main pushes that pass `check` publish multi-architecture `linux/amd64` and `linux/arm64` images tagged `latest` and with the short source commit SHA; images bake `SOURCE_COMMIT=${{ github.sha }}` for `/health` identity.
- Tag pushes that pass `check` publish the literal release tag, refresh `latest`, and create a GitHub Release.
- Every published image (main and tag) carries OCI labels: `org.opencontainers.image.revision` (the commit), `org.opencontainers.image.version` (the application version: the `package.json` version on main, the tag without its `v` on a release), `org.opencontainers.image.source` (the repository) and title, description, url, vendor and licenses. The `Dockerfile` sets them from the `SOURCE_COMMIT` and `APP_VERSION` build arguments and `docker/metadata-action` sets the same revision and version, so `docker image inspect` identifies an image without running it. Before 1.0.23 the tag build set no labels.
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
- [ ] Run `npm ci` and `npm run check:syntax`.
- [ ] Build the Docker image and verify its health check locally when Docker is available.
- [ ] Confirm no secret-bearing `.env` file or generated local artifact is staged.

#### Publish and identify the artifact

- [ ] Create the tag on the validated commit and confirm `git rev-parse "${RELEASE_TAG}^{}"` resolves to that commit.
- [ ] Record the successful CI/release workflow and GitHub Release URL.
- [ ] Confirm both architecture images and the multi-architecture `ghcr.io/spooled-cloud/spooled-example-spriteforge:${RELEASE_TAG}` manifest exist.
- [ ] Confirm the image labels on the pulled image: `docker image inspect ghcr.io/spooled-cloud/spooled-example-spriteforge:${RELEASE_TAG} --format '{{ index .Config.Labels "org.opencontainers.image.revision" }} {{ index .Config.Labels "org.opencontainers.image.version" }}'` prints the release commit and `${RELEASE_VERSION}`.
- [ ] Record the immutable GHCR digest. Do not use mutable `latest` as release identity.
- [ ] Confirm source commit, application version, Git tag, GitHub Release, image tag, and digest describe the same artifact.

#### Deploy separately

- [ ] Record the target environment/platform, operator/provider deployment ID, time, selected immutable tag or digest, and previous rollback artifact.
- [ ] Override `SPRITEFORGE_IMAGE` or the Kustomize image to the recorded immutable tag/digest rather than relying on the checked-in `latest` default.
- [ ] Confirm the actual container or Kubernetes workload resolves to the intended digest and record rollout history.
- [ ] Do not infer deployment from a successful tag workflow, GitHub Release, or GHCR package page.

#### Verify health and end-to-end behavior

- [ ] Call the deployed `GET /health`; require `200` and inspect API/circuit-breaker status, `app.version`, `app.commit`, optional `app.imageDigest`, plus session/job/workflow counters.
- [ ] Check the response headers of `/` (`curl -sSI`): `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and `Content-Security-Policy` are present, and `HEAD /health` answers `200` like the `GET`.
- [ ] Treat `/health` identity as app-reported evidence; still connect live state to the artifact using platform/deployment provenance and the resolved runtime image digest.
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
# Returns 200 while fewer than three consecutive periodic Spooled API checks have failed
# AND the frames and assemble workers are running; 503 (ok: false, missingWorkers) otherwise.
# The JSON includes API/circuit-breaker status plus session, job, workflow, and cleanup counters.

curl -I http://localhost:3000/health
# HEAD answers like GET (same status and headers, no body), for monitors that probe with HEAD.
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
5. **Security Headers**: The app sends `X-Frame-Options: DENY`, `nosniff`, a `Referrer-Policy`, a `Permissions-Policy` and a `Content-Security-Policy` on every response (see "Optional - Security headers"); keep a proxy in front from adding conflicting copies, and set HSTS there.

---

## Support

- [GitHub Issues](https://github.com/spooled-cloud/spooled-example-spriteforge/issues)
- [Spooled Documentation](https://spooled.cloud/docs)
- [Spooled Discord](https://discord.gg/spooled)
