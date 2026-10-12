// Boots the real server (server/server.mjs) as a child process for tests.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "server",
  "server.mjs",
);

export const TEST_API_KEY = "sp_test_dummy_key_0000";

const APP_ENV_KEYS = [
  "TRUST_PROXY",
  "MAX_SSE_CLIENTS",
  "MAX_SSE_PER_IP",
  "WORKER_ID_PREFIX",
  "WORKER_SHUTDOWN_TIMEOUT_MS",
  "CONTENT_SECURITY_POLICY",
];

let ipCounter = 0;
/** A fresh client address per request, so the per-IP rate limiter never trips a test. */
function uniqueIp() {
  ipCounter++;
  return `198.51.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Start the app against `apiUrl`; resolves once it answers HTTP. */
export async function startApp(apiUrl, extraEnv = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    SPOOLED_API_KEY: TEST_API_KEY,
    SPOOLED_BASE_URL: apiUrl,
    SPOOLED_WS_URL: apiUrl.replace(/^http/, "ws"),
    ENABLE_PUBLIC_SCHEDULE: "false",
    ...extraEnv,
  };
  // Keep the host's own settings from leaking into the app under test.
  for (const k of APP_ENV_KEYS) {
    if (!(k in extraEnv)) delete env[k];
  }
  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15000;
  for (;;) {
    try {
      await fetch(`${base}/health`);
      break;
    } catch (e) {
      if (Date.now() > end) {
        child.kill();
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    base,
    port,
    logs: () => output,
    health: async () => {
      const r = await fetch(`${base}/health`);
      return { status: r.status, body: await r.json() };
    },
    post: async (route, payload) => {
      const r = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": uniqueIp() },
        body: JSON.stringify(payload),
      });
      return {
        status: r.status,
        headers: r.headers,
        body: await r.json().catch(() => null),
      };
    },
    stop: () => {
      child.kill();
    },
  };
}

export async function waitUntil(fn, { ms = 30000, every = 200 } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, every));
  }
}
