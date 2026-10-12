# ═══════════════════════════════════════════════════════════════════════════
# SpriteForge Dockerfile
# Multi-stage build for production deployment
# ═══════════════════════════════════════════════════════════════════════════

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --no-audit --no-fund

# Copy source files
COPY . .

# ═══════════════════════════════════════════════════════════════════════════
# Production stage
# ═══════════════════════════════════════════════════════════════════════════

FROM node:20-alpine AS production

WORKDIR /app

ARG SOURCE_COMMIT=unknown
ARG APP_VERSION=unknown

# Install security updates
RUN apk update && apk upgrade --no-cache

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S app -u 1001 -G nodejs

# Copy from builder
COPY --from=builder --chown=app:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=app:nodejs /app/package.json ./package.json
COPY --from=builder --chown=app:nodejs /app/server ./server
COPY --from=builder --chown=app:nodejs /app/public ./public

# Switch to non-root user
USER app

# Environment
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

# OCI image labels: what a pulled image was built from, without running it.
# CI passes SOURCE_COMMIT (git sha) and APP_VERSION (package.json version);
# docker/metadata-action sets the same revision, version and source labels.
#   docker image inspect IMAGE --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
LABEL org.opencontainers.image.title="SpriteForge" \
      org.opencontainers.image.description="Animated pixel-sprite generator powered by Spooled Cloud (jobs, workflows, workers, realtime)" \
      org.opencontainers.image.source="https://github.com/Spooled-Cloud/spooled-example-spriteforge" \
      org.opencontainers.image.url="https://example.spooled.cloud" \
      org.opencontainers.image.vendor="Spooled Cloud" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.version="${APP_VERSION}"

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the server
CMD ["node", "server/server.mjs"]
