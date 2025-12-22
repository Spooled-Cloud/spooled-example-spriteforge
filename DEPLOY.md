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
7. [Health Checks & Monitoring](#health-checks--monitoring)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required

- **Spooled API Key**: Get one from [dashboard.spooled.cloud](https://dashboard.spooled.cloud)
- **Docker** (for container deployments)
- **Cloudflare Tunnel Token** (for production with Cloudflare)

### Recommended

- Dedicated Spooled organization for the demo
- Plan limits to prevent abuse on public deployment

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

Production-ready Kubernetes manifests using Kustomize.

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
kubectl create namespace spriteforge

# Create secret with your API key
kubectl create secret generic spriteforge-secrets \
  --from-literal=SPOOLED_API_KEY=sp_live_your_key \
  -n spriteforge
```

### 2. Deploy Production Overlay

```bash
# Preview what will be applied
kubectl apply -k k8s/overlays/production --dry-run=client -o yaml

# Apply
kubectl apply -k k8s/overlays/production

# Check rollout
kubectl rollout status deployment/spooled-example-spriteforge -n spriteforge
```

### 3. Verify Deployment

```bash
# Check pods
kubectl get pods -n spriteforge

# Check service
kubectl get svc -n spriteforge

# Check ingress
kubectl get ingress -n spriteforge

# View logs
kubectl logs -f deployment/spooled-example-spriteforge -n spriteforge
```

### 4. DNS & TLS

The included Ingress manifest expects:
- **nginx ingress controller**
- **cert-manager** with `letsencrypt-prod` ClusterIssuer
- DNS A/CNAME record pointing `example.spooled.cloud` to your ingress

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

### Optional - Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `production` | Environment |

### Optional - Queues

| Variable | Default |
|----------|---------|
| `QUEUE_FRAMES` | `spriteforge-frames` |
| `QUEUE_ASSEMBLE` | `spriteforge-assemble` |
| `QUEUE_PUBLIC` | `spriteforge-public` |

### Optional - Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CONCURRENCY_FRAMES` | `8` | Parallel frame workers |
| `WORKER_CONCURRENCY_ASSEMBLE` | `2` | Parallel assemble workers |

### Optional - Schedule

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_PUBLIC_SCHEDULE` | `true` | Enable "Sprite of the Minute" |
| `PUBLIC_SCHEDULE_CRON` | `0 * * * * *` | Cron expression |
| `PUBLIC_SCHEDULE_TIMEZONE` | `UTC` | Timezone |

### Optional - Cleanup

| Variable | Default | Description |
|----------|---------|-------------|
| `JOB_RETENTION_HOURS` | `24` | Hours until demo jobs expire and are auto-cleaned |

> **Tip**: For high-traffic public demos, set `JOB_RETENTION_HOURS=1` to clean up jobs faster.

---

## Health Checks & Monitoring

### Health Endpoint

```bash
curl http://localhost:3000/health
# Returns: 200 OK
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
kubectl logs -f deployment/spooled-example-spriteforge -n spriteforge

# Fly.io
fly logs
```

---

## Troubleshooting

### Container won't start

1. Check API key is set: `echo $SPOOLED_API_KEY`
2. Check Spooled is reachable: `curl https://api.spooled.cloud/health`
3. View container logs

### No real-time events

1. Verify WebSocket URL is correct
2. Check browser console for SSE connection errors
3. Verify API key has real-time permissions

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
4. **Rate Limiting**: Consider adding reverse proxy rate limits

---

## Support

- [GitHub Issues](https://github.com/spooled-cloud/spooled-example-spriteforge/issues)
- [Spooled Documentation](https://spooled.cloud/docs)
- [Spooled Discord](https://discord.gg/spooled)
