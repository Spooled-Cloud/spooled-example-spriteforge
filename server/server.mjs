import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, statSync } from 'node:fs';

import { SpooledClient, SpooledRealtime, SpooledWorker } from '@spooled/sdk';

import { generateFrame, PALETTES, getPaletteByName } from './spriteforge.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);

const SPOOLED_API_KEY = process.env.SPOOLED_API_KEY;
if (!SPOOLED_API_KEY) {
  // eslint-disable-next-line no-console
  console.error('Missing required env var: SPOOLED_API_KEY');
  process.exit(1);
}

// How often to run a health check that verifies API connectivity
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// How many consecutive health check failures before auto-restart
const MAX_HEALTH_CHECK_FAILURES = 3;

const SPOOLED_BASE_URL = process.env.SPOOLED_BASE_URL || 'https://api.spooled.cloud';
const SPOOLED_WS_URL = process.env.SPOOLED_WS_URL || 'wss://api.spooled.cloud';

const QUEUE_FRAMES = process.env.QUEUE_FRAMES || 'spriteforge-frames';
const QUEUE_ASSEMBLE = process.env.QUEUE_ASSEMBLE || 'spriteforge-assemble';
const QUEUE_PUBLIC = process.env.QUEUE_PUBLIC || 'spriteforge-public';

const ENABLE_PUBLIC_SCHEDULE = (process.env.ENABLE_PUBLIC_SCHEDULE || 'true').toLowerCase() === 'true';
const PUBLIC_SCHEDULE_NAME = process.env.PUBLIC_SCHEDULE_NAME || 'spriteforge-public-sprite';
const PUBLIC_SCHEDULE_CRON = process.env.PUBLIC_SCHEDULE_CRON || '0 * * * * *';
const PUBLIC_SCHEDULE_TIMEZONE = process.env.PUBLIC_SCHEDULE_TIMEZONE || 'UTC';

const WORKER_CONCURRENCY_FRAMES = Number(process.env.WORKER_CONCURRENCY_FRAMES || 8);
const WORKER_CONCURRENCY_ASSEMBLE = Number(process.env.WORKER_CONCURRENCY_ASSEMBLE || 2);
const WORKER_CONCURRENCY_PUBLIC = Number(process.env.WORKER_CONCURRENCY_PUBLIC || 1);

// Job retention: jobs expire after this duration (default 24 hours for demo)
const JOB_RETENTION_HOURS = Number(process.env.JOB_RETENTION_HOURS || 24);

const MAX_BODY_BYTES = 256 * 1024;
const MAX_FRAMES = 12;

// How often to clean up in-memory session mappings (10 minutes)
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
// Maximum age for session mappings before cleanup (1 hour)
const SESSION_MAPPING_MAX_AGE_MS = 60 * 60 * 1000;

// ---- In-memory session/event plumbing (demo-focused) ----

/** @type {Map<string, Set<import('node:http').ServerResponse>>} */
const sseClientsBySession = new Map();

/** @type {Map<string, { sessionId: string, createdAt: number }>} */
const jobIdToSession = new Map();

/** @type {Map<string, string>} */
const jobIdToKey = new Map();

/** @type {Map<string, { sessionId: string, createdAt: number }>} */
const workflowIdToSession = new Map();

let lastPublicSprite = null;

// Stats for monitoring
const stats = {
  totalWorkflows: 0,
  totalJobs: 0,
  cleanedMappings: 0,
  healthCheckFailures: 0,
  lastHealthCheckAt: null,
  lastHealthCheckStatus: 'unknown',
  circuitBreakerState: 'unknown',
};

/**
 * Periodic health check that verifies API connectivity.
 * If the API becomes unreachable, this can trigger alerts or auto-recovery.
 */
function startHealthCheck() {
  setInterval(async () => {
    try {
      // Try to list queues as a lightweight health check
      await client.queues.list();
      
      stats.lastHealthCheckAt = nowIso();
      stats.lastHealthCheckStatus = 'healthy';
      stats.healthCheckFailures = 0;
      
      // Also check circuit breaker state
      try {
        const cbStats = client.getCircuitBreakerStats();
        stats.circuitBreakerState = cbStats.state;
        
        // Log if circuit breaker is not in normal state
        if (cbStats.state !== 'CLOSED') {
          // eslint-disable-next-line no-console
          console.warn(`[health] Circuit breaker state: ${cbStats.state}, failures: ${cbStats.failureCount}`);
        }
      } catch {
        // SDK might not expose this, ignore
      }
    } catch (err) {
      stats.healthCheckFailures++;
      stats.lastHealthCheckAt = nowIso();
      stats.lastHealthCheckStatus = `failed: ${err?.message || err}`;
      
      // eslint-disable-next-line no-console
      console.error(`[health] API health check failed (${stats.healthCheckFailures}/${MAX_HEALTH_CHECK_FAILURES}):`, err?.message || err);
      
      // If we've failed too many times, try to reset the circuit breaker
      if (stats.healthCheckFailures >= MAX_HEALTH_CHECK_FAILURES) {
        // eslint-disable-next-line no-console
        console.warn('[health] Too many consecutive failures, attempting circuit breaker reset...');
        try {
          client.resetCircuitBreaker();
          // eslint-disable-next-line no-console
          console.log('[health] Circuit breaker reset');
        } catch {
          // ignore
        }
        
        // Also restart realtime connection
        scheduleRealtimeRestart();
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
  
  // eslint-disable-next-line no-console
  console.log(`[health] Health check started (interval: ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
}

/**
 * Periodically clean up old session mappings to prevent memory leaks
 * when many users test the demo.
 */
function startSessionCleanup() {
  setInterval(() => {
    const now = Date.now();
    const cutoff = now - SESSION_MAPPING_MAX_AGE_MS;
    let cleaned = 0;

    for (const [jobId, entry] of jobIdToSession) {
      if (entry.createdAt < cutoff) {
        jobIdToSession.delete(jobId);
        jobIdToKey.delete(jobId);
        cleaned++;
      }
    }

    for (const [workflowId, entry] of workflowIdToSession) {
      if (entry.createdAt < cutoff) {
        workflowIdToSession.delete(workflowId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      stats.cleanedMappings += cleaned;
      // eslint-disable-next-line no-console
      console.log(`[cleanup] Removed ${cleaned} stale session mappings (total cleaned: ${stats.cleanedMappings})`);
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
}

function nowIso() {
  return new Date().toISOString();
}

function sseWrite(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastSession(sessionId, eventName, data) {
  const set = sseClientsBySession.get(sessionId);
  if (!set) return;
  for (const res of set) {
    sseWrite(res, eventName, data);
  }
}

function broadcastAll(eventName, data) {
  for (const sessionId of sseClientsBySession.keys()) {
    broadcastSession(sessionId, eventName, data);
  }
}

function getClientIp(req) {
  const header = (name) => {
    const v = req.headers[name];
    if (Array.isArray(v)) return v[0];
    if (typeof v === 'string' && v.length > 0) return v;
    return null;
  };

  // Prefer Cloudflare / reverse-proxy headers when present
  const cf = header('cf-connecting-ip');
  const xReal = header('x-real-ip');
  const xff = header('x-forwarded-for');

  let ip =
    cf ||
    xReal ||
    (xff ? xff.split(',')[0].trim() : null) ||
    req.socket.remoteAddress ||
    'unknown';

  // Normalize IPv6-mapped IPv4 addresses (e.g. ::ffff:127.0.0.1)
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Very small in-memory rate limiter (good enough for a public demo)
/** @type {Map<string, { tokens: number; last: number }>} */
const ipBuckets = new Map();

function rateLimitOrThrow(ip, { capacity, refillPerSec }) {
  const now = Date.now();
  const state = ipBuckets.get(ip) ?? { tokens: capacity, last: now };
  const elapsed = Math.max(0, (now - state.last) / 1000);
  state.tokens = Math.min(capacity, state.tokens + elapsed * refillPerSec);
  state.last = now;
  if (state.tokens < 1) {
    throw Object.assign(new Error('rate_limited'), { statusCode: 429 });
  }
  state.tokens -= 1;
  ipBuckets.set(ip, state);
}

async function mapLimit(items, limit, fn) {
  const arr = Array.isArray(items) ? items : [];
  const n = Math.max(1, Math.floor(limit || 1));
  const results = new Array(arr.length);
  let next = 0;

  const workers = new Array(Math.min(n, arr.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= arr.length) break;
      results[i] = await fn(arr[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('payload_too_large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  }
}

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(text);
}

function sendNoCacheJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function safeJoinPublic(relPath) {
  const safe = relPath.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) {
    throw Object.assign(new Error('bad_path'), { statusCode: 400 });
  }
  return full;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  const filePath = safeJoinPublic(pathname);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  // Disable caching for the demo to avoid stale JS/CSS when we iterate quickly.
  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

// ---- Spooled wiring ----

const client = new SpooledClient({
  apiKey: SPOOLED_API_KEY,
  baseUrl: SPOOLED_BASE_URL,
  wsUrl: SPOOLED_WS_URL,
  debug: (msg, meta) => {
    if ((process.env.DEBUG || '').toLowerCase() === 'true') {
      // eslint-disable-next-line no-console
      console.log(`[spooled] ${msg}`, meta ?? '');
    }
  },
});

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function seededFloat(seed) {
  const h = crypto.createHash('sha256').update(seed).digest();
  // Use first 4 bytes as uint32
  const n = h.readUInt32BE(0);
  return n / 0xffffffff;
}

async function startWorkers() {
  // Frames worker
  const framesWorker = new SpooledWorker(client, {
    queueName: QUEUE_FRAMES,
    concurrency: clampInt(WORKER_CONCURRENCY_FRAMES, 1, 32),
    leaseDuration: 30,
  });

  framesWorker.process(async (ctx) => {
    const p = ctx.payload || {};
    const seed = String(p.seed || 'seed');
    const paletteName = String(p.paletteName || 'neon');
    const animation = String(p.animation || 'walk');
    const frameIndex = Number(p.frameIndex || 0);
    const frameCount = Number(p.frameCount || 8);
    const width = Number(p.width || 24);
    const height = Number(p.height || 24);
    const sessionId = String(p.sessionId || '');

    const failChance = clampNum(Number(p.failChance || 0), 0, 0.9);
    const failSeed = `${ctx.jobId}|${seed}|${frameIndex}|attempt:${ctx.retryCount}`;

    // Simulate some variable work time (and make it deterministic)
    const latency = 150 + Math.floor(seededFloat(`${failSeed}|lat`) * 850);
    await sleep(latency);

    // Optional chaos mode: fail transiently to demonstrate retries
    if (failChance > 0 && ctx.retryCount < 2) {
      const roll = seededFloat(`${failSeed}|roll`);
      if (roll < failChance) {
        throw new Error('SpriteForge glitch (transient) — demonstrating retries');
      }
    }

    const frame = generateFrame({ seed, paletteName, animation, frameIndex, frameCount, width, height });
    return {
      kind: 'frame',
      sessionId,
      seed,
      paletteName: frame.paletteName,
      animation,
      frameIndex,
      frameCount,
      width: frame.width,
      height: frame.height,
      palette: frame.palette,
      pixels: frame.pixels,
      generatedAt: nowIso(),
    };
  });

  await framesWorker.start();

  // Assemble worker: uses workflow dependencies to fetch all frame job results
  const assembleWorker = new SpooledWorker(client, {
    queueName: QUEUE_ASSEMBLE,
    concurrency: clampInt(WORKER_CONCURRENCY_ASSEMBLE, 1, 8),
    leaseDuration: 60,
  });

  assembleWorker.process(async (ctx) => {
    const p = ctx.payload || {};
    const sessionId = String(p.sessionId || '');
    const seed = String(p.seed || 'seed');
    const paletteName = String(p.paletteName || 'neon');
    const animation = String(p.animation || 'walk');
    const frameCount = Number(p.frameCount || 8);
    const width = Number(p.width || 24);
    const height = Number(p.height || 24);

    // Find dependencies (frame jobs) by asking Spooled for this job's dependency graph.
    const deps = await client.workflows.jobs.getDependencies(ctx.jobId);
    const depJobIds = (deps.dependencies || []).map((d) => d.jobId);

    // Fetch results and order by payload.frameIndex
    const frames = [];
    for (const jobId of depJobIds) {
      const job = await client.jobs.get(jobId);
      if (!job.result || typeof job.result !== 'object') {
        throw new Error(`Missing result for frame job: ${jobId}`);
      }
      frames.push({
        jobId,
        frameIndex: Number(job.payload?.frameIndex ?? 0),
        result: job.result,
      });
    }

    frames.sort((a, b) => a.frameIndex - b.frameIndex);

    const palette = getPaletteByName(paletteName).colors;
    const spriteFrames = frames.map((f) => f.result.pixels);

    await sleep(200 + Math.floor(seededFloat(`${ctx.jobId}|assemble`) * 350));

    return {
      kind: 'sprite',
      sessionId,
      seed,
      paletteName,
      animation,
      frameCount,
      width,
      height,
      palette,
      frames: spriteFrames,
      assembledAt: nowIso(),
    };
  });

  await assembleWorker.start();

  // Public schedule worker: creates a full sprite in a single job
  const publicWorker = new SpooledWorker(client, {
    queueName: QUEUE_PUBLIC,
    concurrency: clampInt(WORKER_CONCURRENCY_PUBLIC, 1, 4),
    leaseDuration: 60,
  });

  publicWorker.process(async (ctx) => {
    const p = ctx.payload || {};
    const animation = String(p.animation || 'dance');
    const paletteName = String(p.paletteName || PALETTES[Math.floor(seededFloat(`${ctx.jobId}|pal`) * PALETTES.length)].name);
    const frameCount = clampInt(Number(p.frameCount || 8), 2, 12);
    const width = clampInt(Number(p.width || 24), 16, 32);
    const height = clampInt(Number(p.height || 24), 16, 32);

    const seed = String(p.seed || `public:${ctx.jobId}`);
    const palette = getPaletteByName(paletteName).colors;
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const frame = generateFrame({ seed, paletteName, animation, frameIndex: i, frameCount, width, height });
      frames.push(frame.pixels);
    }

    await sleep(250 + Math.floor(seededFloat(`${ctx.jobId}|public`) * 650));

    return {
      kind: 'publicSprite',
      seed,
      paletteName,
      animation,
      frameCount,
      width,
      height,
      palette,
      frames,
      generatedAt: nowIso(),
    };
  });

  await publicWorker.start();

  // eslint-disable-next-line no-console
  console.log(
    `Workers started: frames(${QUEUE_FRAMES}) assemble(${QUEUE_ASSEMBLE}) public(${QUEUE_PUBLIC})`
  );

  // Graceful shutdown
  const stop = async () => {
    try {
      await framesWorker.stop();
      await assembleWorker.stop();
      await publicWorker.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function clampInt(n, min, max) {
  const x = Number.isFinite(n) ? Math.floor(n) : min;
  return Math.max(min, Math.min(max, x));
}

function clampNum(n, min, max) {
  const x = Number.isFinite(n) ? n : min;
  return Math.max(min, Math.min(max, x));
}

// How long to wait before attempting to restart a dead realtime connection
const REALTIME_RESTART_DELAY_MS = 30_000; // 30 seconds

/** @type {SpooledRealtime | null} */
let currentRealtime = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let realtimeRestartTimer = null;

/**
 * Start the realtime connection with automatic restart on persistent disconnection.
 * The SDK has built-in reconnect (10 attempts), but if that exhausts, we restart fresh.
 */
async function startRealtime() {
  // Clear any pending restart
  if (realtimeRestartTimer) {
    clearTimeout(realtimeRestartTimer);
    realtimeRestartTimer = null;
  }

  try {
    // Use WebSocket for real-time events (SSE only sends health checks)
    const realtime = /** @type {SpooledRealtime} */ (await client.realtime({ type: 'websocket' }));
    currentRealtime = realtime;

    realtime.onStateChange((state) => {
      // eslint-disable-next-line no-console
      console.log(`[realtime] state changed: ${state}`);
      broadcastAll('server.realtime', { state, at: nowIso() });

      // If connection is fully disconnected (SDK gave up reconnecting), schedule a fresh restart
      if (state === 'disconnected') {
        scheduleRealtimeRestart();
      } else if (realtimeRestartTimer) {
        // Connected or reconnecting - cancel any pending restart
        clearTimeout(realtimeRestartTimer);
        realtimeRestartTimer = null;
      }
    });

    const handleEvent = async (event) => {
      // Route job events to a specific session if we have a mapping.
      // Note: Backend uses snake_case (job_id, queue_name) and PascalCase event types (JobCompleted)
      const data = /** @type {any} */ (event.data || {});
      const jobId = data.job_id || data.jobId;
      const queueName = data.queue_name || data.queueName;

      // Normalize event type for comparison (backend sends PascalCase like "JobCompleted")
      const eventType = event.type;
      const normalizedType = eventType.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase();

      // Log all received events for debugging (uncomment in production if events aren't showing)
      // eslint-disable-next-line no-console
      console.log(`[realtime] ${eventType} job=${jobId?.slice?.(0,8) || 'n/a'} queue=${queueName || 'n/a'} tracked=${jobIdToSession.has(jobId)}`);

      // Many realtime events only include identifiers; the authoritative status/retry/result live on the Job record.
      // Fetch on completion/failure to make the UI accurate and to avoid missing fields.
      // Only fetch full job details for SpriteForge-tracked jobs or the public demo queue.
      // Otherwise we'd create unnecessary load and potentially leak data from unrelated jobs in the org.
      const isTracked = typeof jobId === 'string' && jobIdToSession.has(jobId);
      const isPublic = queueName === QUEUE_PUBLIC;

      /** @type {any | undefined} */
      let fetchedJob = undefined;
      const shouldFetchJob =
        (isTracked || isPublic) &&
        typeof jobId === 'string' &&
        (eventType === 'JobCompleted' ||
          normalizedType === 'job.completed' ||
          eventType === 'JobFailed' ||
          normalizedType === 'job.failed');

      if (shouldFetchJob) {
        try {
          fetchedJob = await client.jobs.get(jobId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`Could not fetch job ${jobId}:`, err?.message || err);
        }
      }

      const result = fetchedJob?.result ?? data.result;
      const status = fetchedJob?.status ?? data.status;
      const retryCount =
        fetchedJob?.retryCount ??
        fetchedJob?.retry_count ??
        data.retry_count ??
        data.retryCount ??
        undefined;

      if ((eventType === 'JobCompleted' || normalizedType === 'job.completed') && queueName === QUEUE_PUBLIC) {
        // Broadcast the latest public sprite to all
        lastPublicSprite = {
          ...event,
          data: {
            ...data,
            ...(result !== undefined ? { result } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(retryCount !== undefined ? { retry_count: retryCount } : {}),
          },
          at: nowIso(),
        };
        broadcastAll('public.sprite', lastPublicSprite);
        return;
      }

      if (typeof jobId === 'string' && jobIdToSession.has(jobId)) {
        const sessionId = jobIdToSession.get(jobId)?.sessionId;
        // Transform event to use camelCase for the frontend
        const transformedEvent = {
          type: normalizedType,
          data: {
            jobId,
            queueName,
            ...data,
            // Ensure fetched values win (spread order matters!)
            ...(status !== undefined ? { status } : {}),
            ...(retryCount !== undefined ? { retryCount } : {}),
            ...(result !== undefined ? { result } : {}),
          },
        };
        // eslint-disable-next-line no-console
        console.log(`[broadcast] → session ${sessionId?.slice(0,8)} event=${normalizedType} job=${jobId?.slice(0,8)}`);
        broadcastSession(sessionId, 'spooled', {
          ...transformedEvent,
          meta: {
            sessionId,
            key: jobIdToKey.get(jobId) || null,
          },
        });
        return;
      }

      // For job events where we have a jobId but it's not tracked yet (e.g., created in another context)
      // Still broadcast if it matches our demo queues
      if (
        typeof jobId === 'string' &&
        (queueName === QUEUE_FRAMES || queueName === QUEUE_ASSEMBLE || queueName === QUEUE_PUBLIC)
      ) {
        // eslint-disable-next-line no-console
        console.log(`[realtime] Untracked job event for demo queue: ${eventType} job=${jobId.slice(0,8)}`);
      }

      // Global events: queue pause/resume, schedule triggers, etc.
      if (
        normalizedType.startsWith('queue.') ||
        normalizedType.startsWith('worker.') ||
        normalizedType.startsWith('schedule.') ||
        normalizedType === 'heartbeat' ||
        eventType === 'Ping'
      ) {
        broadcastAll('spooled', event);
      }
    };

    // IMPORTANT: don't make the event callback `async` directly. Many event emitters won't await it,
    // and thrown errors become unhandled promise rejections that can crash the process.
    realtime.onEvent((event) => {
      void handleEvent(event).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('Realtime event handler error:', err?.message || err);
      });
    });

    await realtime.connect();

    // Note: The backend automatically subscribes to all org events on connect.
    // No need to call realtime.subscribe() - it would timeout because the backend
    // doesn't respond to subscribe commands in the SDK's expected format.

    // eslint-disable-next-line no-console
    console.log(`✅ Spooled realtime connected (WebSocket) to ${SPOOLED_WS_URL}/api/v1/ws`);

    return realtime;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Spooled realtime connection failed (continuing without live updates):', error?.message || error);
    // Schedule a restart attempt
    scheduleRealtimeRestart();
    return null;
  }
}

/**
 * Schedule a restart of the realtime connection after a delay.
 * This handles cases where the SDK exhausts its reconnect attempts.
 */
function scheduleRealtimeRestart() {
  if (realtimeRestartTimer) {
    return; // Already scheduled
  }

  // eslint-disable-next-line no-console
  console.log(`[realtime] Will attempt fresh restart in ${REALTIME_RESTART_DELAY_MS / 1000}s...`);

  realtimeRestartTimer = setTimeout(async () => {
    realtimeRestartTimer = null;

    // Disconnect old instance if any
    if (currentRealtime) {
      try {
        currentRealtime.disconnect();
      } catch {
        // ignore
      }
      currentRealtime = null;
    }

    // eslint-disable-next-line no-console
    console.log('[realtime] Attempting fresh restart...');
    await startRealtime();
  }, REALTIME_RESTART_DELAY_MS);
}

async function ensurePublicSchedule() {
  if (!ENABLE_PUBLIC_SCHEDULE) {
    // eslint-disable-next-line no-console
    console.log('Public schedule disabled (ENABLE_PUBLIC_SCHEDULE=false)');
    return;
  }

  const maxAttempts = 3;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Try to list existing schedules
      let schedules = [];
      try {
        schedules = await client.schedules.list();
      } catch (listError) {
        // If we can't list (e.g., permission error), try to create anyway
        // eslint-disable-next-line no-console
        console.warn(`Could not list schedules (attempt ${attempt}):`, listError?.message || listError);
      }

      const existing = schedules.find((s) => s.name === PUBLIC_SCHEDULE_NAME);
      
      if (existing) {
        // eslint-disable-next-line no-console
        console.log(`✓ Public schedule exists: ${existing.id} (cron: ${existing.cronExpression})`);
        
        // Resume if paused
        if (!existing.isActive) {
          try {
            await client.schedules.resume(existing.id);
            // eslint-disable-next-line no-console
            console.log(`  → Resumed paused schedule: ${existing.id}`);
          } catch (resumeError) {
            // eslint-disable-next-line no-console
            console.warn('  → Failed to resume schedule:', resumeError?.message || resumeError);
          }
        }
        return; // Success!
      }

      // Schedule doesn't exist, create it
      // eslint-disable-next-line no-console
      console.log(`Creating public schedule "${PUBLIC_SCHEDULE_NAME}" (attempt ${attempt})...`);

      const created = await client.schedules.create({
        name: PUBLIC_SCHEDULE_NAME,
        description: 'SpriteForge demo: generate a new public sprite periodically',
        cronExpression: PUBLIC_SCHEDULE_CRON,
        timezone: PUBLIC_SCHEDULE_TIMEZONE,
        queueName: QUEUE_PUBLIC,
        payloadTemplate: {
          kind: 'publicSprite',
          animation: 'dance',
          frameCount: 8,
          width: 24,
          height: 24,
        },
        maxRetries: 3,
        timeoutSeconds: 60,
      });

      // eslint-disable-next-line no-console
      console.log(`✓ Created public schedule: ${created.id} (next run: ${created.nextRunAt || 'unknown'})`);
      return; // Success!

    } catch (error) {
      const errorCode = error?.code || error?.statusCode || 'unknown';
      const errorMsg = error?.message || String(error);

      // Handle "already exists" gracefully (race condition or previous API key had same schedule)
      if (errorCode === 'CONFLICT' || errorMsg.includes('already exists') || errorMsg.includes('duplicate')) {
        // eslint-disable-next-line no-console
        console.log(`✓ Public schedule already exists (created by another instance or previous run)`);
        return;
      }

      // eslint-disable-next-line no-console
      console.warn(`Schedule setup attempt ${attempt}/${maxAttempts} failed:`, errorMsg);

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }

  // All attempts failed, continue without schedule
  // eslint-disable-next-line no-console
  console.warn('⚠ Public schedule setup failed after all attempts (continuing without it)');
}

// ---- HTTP routes ----

function handleSse(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  const sessionId = url.searchParams.get('sessionId') || crypto.randomUUID();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Register
  if (!sseClientsBySession.has(sessionId)) sseClientsBySession.set(sessionId, new Set());
  sseClientsBySession.get(sessionId).add(res);

  // Hello event with config + palette list + last public sprite
  sseWrite(res, 'hello', {
    sessionId,
    serverTime: nowIso(),
    queues: {
      frames: QUEUE_FRAMES,
      assemble: QUEUE_ASSEMBLE,
      public: QUEUE_PUBLIC,
    },
    palettes: PALETTES.map((p) => ({ name: p.name, colors: p.colors })),
    lastPublicSprite,
  });

  const heartbeat = setInterval(() => {
    sseWrite(res, 'ping', { t: Date.now() });
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClientsBySession.get(sessionId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClientsBySession.delete(sessionId);
    }
  });
}

async function handleForge(req, res) {
  const ip = getClientIp(req);

  // Roughly: 1 request/sec sustained, burst 6
  rateLimitOrThrow(ip, { capacity: 6, refillPerSec: 1 });

  const body = await readJson(req);
  const sessionId = String(body.sessionId || '');
  const seed = String(body.seed || '').slice(0, 64) || crypto.randomUUID().slice(0, 8);
  const paletteName = String(body.paletteName || 'neon');
  const animation = String(body.animation || 'walk');
  const frameCount = clampInt(Number(body.frameCount || 8), 2, MAX_FRAMES);
  const width = clampInt(Number(body.width || 24), 16, 32);
  const height = clampInt(Number(body.height || 24), 16, 32);
  const failChance = clampNum(Number(body.failChance || 0), 0, 0.9);

  if (!sessionId) {
    sendJson(res, 400, { error: 'missing_session_id' });
    return;
  }

  // Calculate expiration time for jobs (demo jobs should auto-cleanup)
  const expiresAt = new Date(Date.now() + JOB_RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const jobs = [];
  for (let i = 0; i < frameCount; i++) {
    jobs.push({
      key: `frame-${i}`,
      queueName: QUEUE_FRAMES,
      payload: {
        kind: 'frame',
        sessionId,
        seed,
        paletteName,
        animation,
        frameIndex: i,
        frameCount,
        width,
        height,
        failChance,
      },
      maxRetries: 5,
      timeoutSeconds: 30,
      expiresAt,
    });
  }

  jobs.push({
    key: 'assemble',
    queueName: QUEUE_ASSEMBLE,
    dependsOn: jobs.filter((j) => j.key.startsWith('frame-')).map((j) => j.key),
    payload: {
      kind: 'assemble',
      sessionId,
      seed,
      paletteName,
      animation,
      frameCount,
      width,
      height,
    },
    maxRetries: 5,
    timeoutSeconds: 60,
    expiresAt,
  });

  const workflowName = `spriteforge-${sessionId}-${seed}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);

  let created;
  try {
    created = await client.workflows.create({
      name: workflowName,
      jobs,
      metadata: {
        demo: 'spriteforge',
        sessionId,
        seed,
      },
    });
  } catch (workflowError) {
    // Log detailed error info for debugging
    const errorInfo = typeof workflowError?.toJSON === 'function' 
      ? workflowError.toJSON() 
      : { message: workflowError?.message, code: workflowError?.code, statusCode: workflowError?.statusCode };
    
    // eslint-disable-next-line no-console
    console.error('Workflow creation failed:', errorInfo);
    
    // Log circuit breaker state when errors occur
    try {
      const cbStats = client.getCircuitBreakerStats();
      // eslint-disable-next-line no-console
      console.error('  Circuit breaker state:', cbStats.state, 'failures:', cbStats.failureCount);
      stats.circuitBreakerState = cbStats.state;
    } catch {
      // ignore
    }
    
    // If this is an auth error, update health status
    if (workflowError?.statusCode === 401) {
      stats.healthCheckFailures++;
      stats.lastHealthCheckStatus = `auth_failed: ${workflowError?.message}`;
    }
    
    throw workflowError;
  }

  const createdAt = Date.now();
  workflowIdToSession.set(created.workflowId, { sessionId, createdAt });

  // Track mapping for event routing
  for (const j of created.jobIds) {
    jobIdToSession.set(j.jobId, { sessionId, createdAt });
    jobIdToKey.set(j.jobId, j.key);
  }
  
  // eslint-disable-next-line no-console
  console.log(`[forge] Tracking ${created.jobIds.length} jobs for session ${sessionId.slice(0,8)}: ${created.jobIds.map(j => j.jobId.slice(0,8)).join(', ')}`);

  // Update stats
  stats.totalWorkflows++;
  stats.totalJobs += created.jobIds.length;

  sendJson(res, 200, {
    workflowId: created.workflowId,
    jobIds: created.jobIds,
  });
}

async function handleJobsBatch(req, res) {
  const ip = getClientIp(req);
  // Poller calls this ~1/sec per user; allow sustained usage but block abuse.
  rateLimitOrThrow(`${ip}|jobs_batch`, { capacity: 20, refillPerSec: 8 });

  const body = await readJson(req);
  const sessionId = String(body.sessionId || '');
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds : [];
  const includeResult = Boolean(body.includeResult);
  if (!sessionId) {
    sendNoCacheJson(res, 400, { error: 'missing_session_id' });
    return;
  }
  if (jobIds.length === 0) {
    sendNoCacheJson(res, 200, { jobs: [] });
    return;
  }

  // Hard cap to prevent abuse on the public demo.
  // Also: only allow fetching jobIds that belong to this session (prevents probing arbitrary job IDs).
  const capped = jobIds
    .slice(0, 50)
    .filter((id) => typeof id === 'string' && id.length > 0)
    .filter((jobId) => jobIdToSession.get(jobId)?.sessionId === sessionId);
  const jobsOut = await mapLimit(capped, 8, async (jobId) => {
    try {
      const job = await client.jobs.get(jobId);
      return {
        jobId,
        status: job.status,
        retryCount: job.retryCount ?? job.retry_count ?? 0,
        scheduledAt: job.scheduledAt ?? job.scheduled_at ?? null,
        result: includeResult ? (job.result ?? null) : null,
      };
    } catch (err) {
      return {
        jobId,
        error: err?.message || String(err),
      };
    }
  });

  sendNoCacheJson(res, 200, { jobs: jobsOut });
}

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    if (method === 'GET' && url.pathname === '/health') {
      // Determine health status based on recent API connectivity
      const isHealthy = stats.healthCheckFailures < MAX_HEALTH_CHECK_FAILURES;
      
      sendJson(res, isHealthy ? 200 : 503, { 
        ok: isHealthy, 
        at: nowIso(),
        api: {
          status: stats.lastHealthCheckStatus,
          lastCheckAt: stats.lastHealthCheckAt,
          consecutiveFailures: stats.healthCheckFailures,
          circuitBreakerState: stats.circuitBreakerState,
        },
        stats: {
          activeSessions: sseClientsBySession.size,
          trackedJobs: jobIdToSession.size,
          trackedWorkflows: workflowIdToSession.size,
          totalWorkflows: stats.totalWorkflows,
          totalJobs: stats.totalJobs,
          cleanedMappings: stats.cleanedMappings,
        },
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/events') {
      handleSse(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/forge') {
      await handleForge(req, res);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/jobs/batch') {
      await handleJobsBatch(req, res);
      return;
    }

    // Static UI
    if (method === 'GET') {
      serveStatic(req, res);
      return;
    }

    sendText(res, 404, 'Not found');
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    const code =
      error?.message === 'rate_limited'
        ? 'rate_limited'
        : error?.message === 'payload_too_large'
          ? 'payload_too_large'
          : error?.message === 'invalid_json'
            ? 'invalid_json'
            : (typeof error?.code === 'string' ? error.code : 'internal_error');

    // Include the message to make debugging the demo much easier
    sendJson(res, status, { error: code, message: error?.message || String(error) });
  }
});

// ---- bootstrap ----

(async function main() {
  // eslint-disable-next-line no-console
  console.log('═══════════════════════════════════════════════════════════════');
  // eslint-disable-next-line no-console
  console.log('  SpriteForge — Spooled Cloud Demo');
  // eslint-disable-next-line no-console
  console.log('═══════════════════════════════════════════════════════════════');
  // eslint-disable-next-line no-console
  console.log(`  API: ${SPOOLED_BASE_URL}`);
  // eslint-disable-next-line no-console
  console.log(`  Job retention: ${JOB_RETENTION_HOURS} hours`);
  // eslint-disable-next-line no-console
  console.log('───────────────────────────────────────────────────────────────');

  await startWorkers();
  await startRealtime();
  await ensurePublicSchedule();

  // Start periodic cleanup of session mappings to prevent memory leaks
  startSessionCleanup();
  
  // Start periodic health check to detect API connectivity issues
  startHealthCheck();

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log('───────────────────────────────────────────────────────────────');
    // eslint-disable-next-line no-console
    console.log(`✓ Server listening on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log('═══════════════════════════════════════════════════════════════');
  });
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', err);
  process.exit(1);
});


