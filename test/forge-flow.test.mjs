import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { defaultWorkerIdPrefix } from "../server/guards.mjs";
import { startApp, TEST_API_KEY, waitUntil } from "./helpers/app.mjs";
import { startMockSpooled } from "./helpers/mock-spooled.mjs";

const SESSION = "123e4567-e89b-12d3-a456-426614174000";
const stoppers = [];
after(async () => {
  for (const stop of stoppers) await stop();
});
const track = (fn) => stoppers.push(fn);

async function runningApp(mockOptions = {}, env = {}) {
  const mock = await startMockSpooled(mockOptions);
  track(() => mock.close());
  const app = await startApp(mock.url, env);
  track(() => app.stop());
  // /health is 200 as soon as frames and assemble run; the public worker
  // registers right after them, so wait for all three (the registrations the
  // tests read from the mock would otherwise race).
  await waitUntil(async () => {
    const h = await app.health();
    return h.status === 200 && h.body.workers?.public === "running";
  });
  return { mock, app };
}

// ---- the happy path, against the in-process API -------------------------------

let main;
before(async () => {
  main = await runningApp();
});

test("forge flow: workflow is created, frames run, assemble builds the sprite", async () => {
  const forge = await main.app.post("/api/forge", {
    sessionId: SESSION,
    seed: "flow-test",
    frameCount: 3,
  });
  assert.equal(forge.status, 200, JSON.stringify(forge.body));
  assert.equal(forge.body.jobIds.length, 4); // 3 frames + assemble

  const ids = forge.body.jobIds.map((j) => j.jobId);
  const assemble = forge.body.jobIds.find((j) => j.key === "assemble").jobId;
  const sprite = await waitUntil(async () => {
    const r = await main.app.post("/api/jobs/batch", {
      sessionId: SESSION,
      jobIds: ids,
      includeResult: true,
    });
    const job = r.body.jobs.find((j) => j.jobId === assemble);
    return job?.status === "completed" ? job.result : null;
  });
  assert.equal(sprite.kind, "sprite");
  assert.equal(sprite.frames.length, 3);
});

test("/health is ok with all three workers running", async () => {
  const { status, body } = await main.app.health();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.workers, { frames: "running", assemble: "running", public: "running" });
  assert.deepEqual(body.missingWorkers, []);
});

test("default worker ids are per API key, not the shared name 'spriteforge'", () => {
  const prefix = defaultWorkerIdPrefix(TEST_API_KEY);
  assert.match(prefix, /^spriteforge-[0-9a-f]{8}$/);
  const ids = main.mock.registers.map((r) => r.workerId).sort();
  assert.deepEqual(ids, [`${prefix}-assemble`, `${prefix}-frames`, `${prefix}-public`]);
});

test("sse default per-IP cap is 30 (shared NAT)", async () => {
  const { body } = await main.app.health();
  assert.equal(body.sse.maxPerIp, 30);
  assert.equal(body.sse.maxClients, 500);
});

// ---- sessionId validation on forge and batch -----------------------------------

for (const route of ["/api/forge", "/api/jobs/batch"]) {
  test(`${route} rejects a missing or malformed sessionId with 400`, async () => {
    const extra = route === "/api/forge" ? { seed: "x" } : { jobIds: ["a"] };
    for (const bad of ["short", "x".repeat(65), 'a b<script>aaaa', "../../etc/passwd", 12345678, {}]) {
      const r = await main.app.post(route, { ...extra, sessionId: bad });
      assert.equal(r.status, 400, `${route} ${JSON.stringify(bad)}`);
      assert.equal(r.body.error, "invalid_session_id");
    }
    const missing = await main.app.post(route, extra);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "missing_session_id");
  });
}

test("a JSON body that is not an object is a 400, not a crash", async () => {
  for (const payload of [null, [], "text", 7]) {
    const r = await main.app.post("/api/forge", payload);
    assert.equal(r.status, 400, JSON.stringify(payload));
    assert.equal(r.body.error, "invalid_json");
  }
});

// ---- plan errors are relayed as what they are ----------------------------------

test("Free plan: workflows disabled is relayed as 403 feature_disabled, not UNKNOWN_ERROR", async () => {
  const { app } = await runningApp({ mode: "free_workflow" });
  const r = await app.post("/api/forge", { sessionId: SESSION, seed: "free" });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, "feature_disabled");
  assert.equal(r.body.feature, "workflows");
  assert.equal(r.body.plan, "free");
  assert.match(r.body.message, /not available on the Free plan/);
  assert.ok(!JSON.stringify(r.body).includes("UNKNOWN_ERROR"));
});

// ---- environment pass-through ------------------------------------------------------

test("blank pass-through values (compose `VAR: ${VAR:-}`) mean the app defaults", async () => {
  const blank = {
    TRUST_PROXY: "",
    MAX_SSE_CLIENTS: "",
    MAX_SSE_PER_IP: "",
    WORKER_ID_PREFIX: "",
    WORKER_SHUTDOWN_TIMEOUT_MS: "",
  };
  const { mock, app } = await runningApp({}, blank);
  const { body } = await app.health();
  assert.equal(body.sse.maxClients, 500);
  assert.equal(body.sse.maxPerIp, 30);
  const prefix = defaultWorkerIdPrefix(TEST_API_KEY);
  assert.ok(mock.registers.every((r) => r.workerId.startsWith(`${prefix}-`)), JSON.stringify(mock.registers));
});

test("an explicit WORKER_ID_PREFIX is used as given", async () => {
  const { mock } = await runningApp({}, { WORKER_ID_PREFIX: "my-demo" });
  const ids = mock.registers.map((r) => r.workerId).sort();
  assert.deepEqual(ids, ["my-demo-assemble", "my-demo-frames", "my-demo-public"]);
});

// TRUST_PROXY: "false" was the only spelling that turned it off.
async function secondDistinctIpIsAdmitted(trustProxy) {
  const env = { MAX_SSE_PER_IP: "1" };
  if (trustProxy !== undefined) env.TRUST_PROXY = trustProxy;
  // no API needed for the event stream
  const app = await startApp("http://127.0.0.1:9", env);
  const open = [];
  try {
    const first = new AbortController();
    open.push(first);
    const a = await fetch(`${app.base}/api/events`, {
      headers: { "cf-connecting-ip": "203.0.113.1" },
      signal: first.signal,
    });
    assert.equal(a.status, 200);
    const second = new AbortController();
    open.push(second);
    const b = await fetch(`${app.base}/api/events`, {
      headers: { "cf-connecting-ip": "203.0.113.2" },
      signal: second.signal,
    });
    return b.status === 200;
  } finally {
    open.forEach((c) => c.abort());
    app.stop();
  }
}

test("TRUST_PROXY default trusts the proxy header (distinct client IPs are admitted)", async () => {
  assert.equal(await secondDistinctIpIsAdmitted(undefined), true);
  assert.equal(await secondDistinctIpIsAdmitted("true"), true);
});

test("TRUST_PROXY accepts false / 0 / no / off (trimmed, any case) as off", async () => {
  for (const off of ["false", " Off ", "0", "NO"]) {
    assert.equal(await secondDistinctIpIsAdmitted(off), false, `TRUST_PROXY=${JSON.stringify(off)}`);
  }
});
