import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server",
  "server.mjs",
);

function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SPOOLED_API_KEY: "sp_test_dummy_key_0000",
      SPOOLED_BASE_URL: "http://127.0.0.1:9",
      SPOOLED_WS_URL: "ws://127.0.0.1:9",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  return child;
}

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fetch(url);
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// Without the fix the server only listened after every worker registered, so
// an unreachable API / a plan that refuses a worker meant exit(1) and no UI.
test("serves / and /health even when the Spooled API is unreachable", async () => {
  const port = 38000 + Math.floor(Math.random() * 1000);
  const child = startServer(port);
  try {
    const home = await waitFor(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.ok([200, 503].includes(health.status));
    const body = await health.json();
    assert.equal(typeof body.workers, "object");
    assert.equal(body.sse.maxPerIp > 0, true);
  } finally {
    child.kill();
  }
});

test("/api/events answers 429 past the per-IP SSE cap", async () => {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = startServer(port, { MAX_SSE_PER_IP: "2" });
  const controllers = [];
  try {
    await waitFor(`http://127.0.0.1:${port}/health`);
    for (let i = 0; i < 2; i++) {
      const c = new AbortController();
      controllers.push(c);
      const r = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: c.signal,
      });
      assert.equal(r.status, 200);
    }
    const over = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(over.status, 429);
    assert.equal((await over.json()).error, "sse_per_ip_limit");
  } finally {
    controllers.forEach((c) => c.abort());
    child.kill();
  }
});

// Before the fix /health said 200 (the API check had not failed yet) and Forge
// created workflows nobody could run while the workers were not registered.
test("/health is 503 and Forge is refused while the workers cannot register", async () => {
  const port = 40000 + Math.floor(Math.random() * 1000);
  const child = startServer(port);
  try {
    const health = await waitFor(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 503);
    const body = await health.json();
    assert.equal(body.ok, false);
    assert.deepEqual(body.missingWorkers, ["frames", "assemble"]);

    const forge = await fetch(`http://127.0.0.1:${port}/api/forge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "123e4567-e89b-12d3-a456-426614174000" }),
    });
    assert.equal(forge.status, 503);
    const forgeBody = await forge.json();
    assert.equal(forgeBody.error, "workers_unavailable");
    assert.match(forgeBody.message, /not running/);
  } finally {
    child.kill();
  }
});
