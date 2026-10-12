import test from "node:test";
import assert from "node:assert/strict";

import {
  AuthenticationError,
  CircuitBreakerOpenError,
  ConflictError,
  NetworkError,
  RateLimitError,
  ServerError,
  TimeoutError,
} from "@spooled/sdk";

import {
  classifyStartError,
  createErrorLogLimiter,
  isWorkerIdUnavailable,
  missingWorkers,
  startRetryDelayMs,
  superviseWorker,
  WORKER_START_RETRY,
} from "../server/worker-supervisor.mjs";

// ---- fakes -----------------------------------------------------------------

/**
 * Behaves like SpooledWorker for the part that matters here: start() runs
 * once; after a failed start the instance is in state "error" and refuses to
 * start again (SDK 1.3.0: "Cannot start worker in state: error").
 */
function makeHarness(outcomes) {
  const created = [];
  const timers = [];
  const logs = { warn: [], error: [] };
  const states = [];
  const started = [];

  class FakeWorker {
    constructor(opts) {
      this.opts = opts;
      this.state = "idle";
      this.startCalls = 0;
      this.stopCalls = 0;
    }
    async start() {
      this.startCalls++;
      if (this.state !== "idle") {
        throw new Error(`Cannot start worker in state: ${this.state}`);
      }
      this.state = "starting";
      const outcome = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
      const result = typeof outcome === "function" ? await outcome() : outcome;
      if (result instanceof Error) {
        this.state = "error";
        throw result;
      }
      this.state = "running";
    }
    async stop() {
      this.stopCalls++;
      this.state = "stopped";
    }
  }

  const sup = superviseWorker({
    name: "frames",
    create: (opts) => {
      const w = new FakeWorker(opts);
      created.push(w);
      return w;
    },
    onState: (s) => states.push(s),
    onStarted: (w) => started.push(w),
    log: {
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
    random: () => 1,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      t.cleared = true;
    },
  });

  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const fireTimer = async () => {
    const t = timers.filter((x) => !x.cleared).at(-1);
    assert.ok(t, "a retry timer is pending");
    t.cleared = true;
    t.fn();
    await flush();
    return t;
  };
  return { sup, created, timers, logs, states, started, flush, fireTimer };
}

const serverError = () => new ServerError("maintenance", 503, "SERVICE_UNAVAILABLE");

// ---- classification and delays ----------------------------------------------

test("start errors: 5xx / network / timeout / breaker / plain 429 are transient", () => {
  for (const err of [
    serverError(),
    new NetworkError("fetch failed"),
    new TimeoutError("timed out", 30000),
    new CircuitBreakerOpenError(),
    new RateLimitError("slow down", "RATE_LIMIT_EXCEEDED", { retryAfter: 2 }),
    new Error("socket hang up"),
  ]) {
    assert.equal(classifyStartError(err), "transient", err.name);
  }
});

test("start errors: plan quota and other 4xx answers are not hammered", () => {
  assert.equal(
    classifyStartError(new RateLimitError("workers limit reached (1/1)", "QUOTA_EXCEEDED")),
    "quota",
  );
  assert.equal(classifyStartError(new AuthenticationError("bad key")), "rejected");
  assert.equal(classifyStartError(new ConflictError("nope")), "rejected");
});

test("retry delay: exponential with a cap for transient, slow for quota / 4xx", () => {
  const r = WORKER_START_RETRY;
  assert.equal(startRetryDelayMs("transient", 1, r, () => 1), 2_000);
  assert.equal(startRetryDelayMs("transient", 2, r, () => 1), 4_000);
  assert.equal(startRetryDelayMs("transient", 3, r, () => 1), 8_000);
  assert.equal(startRetryDelayMs("transient", 30, r, () => 1), r.maxMs);
  // jitter only shortens, so the cap holds
  assert.ok(startRetryDelayMs("transient", 30, r, () => 0) <= r.maxMs);
  assert.ok(startRetryDelayMs("transient", 1, r, () => 0) >= 1_500);
  assert.equal(startRetryDelayMs("quota", 1, r), r.slowMs);
  assert.equal(startRetryDelayMs("rejected", 5, r), r.slowMs);
  assert.ok(r.slowMs >= 60_000, "slow retries are minutes apart");
});

test("worker id refusal: 409 with a worker_id message (old and new API wording)", () => {
  assert.equal(
    isWorkerIdUnavailable(
      new ConflictError(
        "This worker_id cannot be used: register with a different worker_id, or omit it to get a generated one",
        "CONFLICT",
      ),
    ),
    true,
  );
  assert.equal(isWorkerIdUnavailable(new ConflictError("Worker ID already in use")), true);
  assert.equal(
    isWorkerIdUnavailable(new ConflictError("x", "WORKER_ID_UNAVAILABLE")),
    true,
  );
  assert.equal(isWorkerIdUnavailable(new ConflictError("queue config conflict")), false);
  assert.equal(isWorkerIdUnavailable(serverError()), false);
  assert.equal(isWorkerIdUnavailable(null), false);
});

test("missingWorkers: frames and assemble must run, public is optional", () => {
  assert.deepEqual(missingWorkers({}), ["frames", "assemble"]);
  assert.deepEqual(
    missingWorkers({ frames: "running", assemble: "failed: x", public: "running" }),
    ["assemble"],
  );
  assert.deepEqual(
    missingWorkers({ frames: "running", assemble: "running", public: "quota_exceeded" }),
    [],
  );
  assert.deepEqual(missingWorkers({ frames: "starting", assemble: "running" }), ["frames"]);
});

// ---- supervision -------------------------------------------------------------

// Without a factory the retry would call start() on the failed instance again
// and get "Cannot start worker in state: error" forever.
test("a transient start failure is retried with backoff on a NEW worker each time", async () => {
  const h = makeHarness([serverError(), new NetworkError("fetch failed"), null]);
  await h.sup.ready;

  assert.equal(h.created.length, 1);
  assert.deepEqual(h.states, ["starting", "failed: maintenance"]);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 2_000);
  assert.equal(h.started.length, 0);

  await h.fireTimer();
  assert.equal(h.created.length, 2);
  assert.equal(h.timers.at(-1).ms, 4_000);
  assert.equal(h.states.at(-1), "failed: fetch failed");

  await h.fireTimer();
  assert.equal(h.created.length, 3);
  assert.equal(h.states.at(-1), "running");
  assert.equal(h.started.length, 1);
  assert.equal(h.started[0], h.created[2]);
  assert.ok(h.created.every((w) => w.startCalls === 1), "no instance is started twice");
  assert.equal(h.sup.getWorker(), h.created[2]);
  assert.equal(h.timers.filter((t) => !t.cleared).length, 0, "no retry once running");
});

test("backoff doubles across consecutive transient failures", async () => {
  const h = makeHarness([serverError(), serverError(), null]);
  await h.sup.ready;
  assert.equal(h.timers.at(-1).ms, 2_000);
  await h.fireTimer();
  assert.equal(h.timers.at(-1).ms, 4_000);
  await h.fireTimer();
  assert.equal(h.states.at(-1), "running");
});

test("a plan quota is reported as quota_exceeded and retried slowly, then recovers", async () => {
  const quota = new RateLimitError("workers limit reached (1/1)", "QUOTA_EXCEEDED");
  const h = makeHarness([quota, quota, null]);
  await h.sup.ready;
  assert.equal(h.states.at(-1), "quota_exceeded");
  assert.equal(h.timers.at(-1).ms, WORKER_START_RETRY.slowMs);
  assert.match(h.logs.error[0], /plan limit/);

  await h.fireTimer();
  assert.equal(h.states.at(-1), "quota_exceeded");
  assert.equal(h.timers.at(-1).ms, WORKER_START_RETRY.slowMs, "no escalation, no hammering");

  await h.fireTimer();
  assert.equal(h.states.at(-1), "running");
  assert.equal(h.created.length, 3);
});

test("409 on the stable worker id falls back to a generated id, logged once", async () => {
  const taken = new ConflictError(
    "This worker_id cannot be used: register with a different worker_id, or omit it to get a generated one",
    "CONFLICT",
  );
  const h = makeHarness([taken, serverError(), null]);
  await h.sup.ready;

  // the fallback is immediate (not counted as a failure, no timer for it)
  assert.deepEqual(
    h.created.map((w) => w.opts.useServerId),
    [false, true],
  );
  assert.equal(h.logs.warn.length, 1);
  assert.match(h.logs.warn[0], /without a workerId/);
  // the second attempt then hit a transient error: a timer, not a second fallback
  assert.equal(h.timers.length, 1);

  await h.fireTimer();
  assert.equal(h.states.at(-1), "running");
  assert.deepEqual(
    h.created.map((w) => w.opts.useServerId),
    [false, true, true],
  );
  assert.equal(h.logs.warn.length, 1, "the fallback is logged once, not per retry");
});

test("stop() cancels the pending retry and never starts another worker", async () => {
  const h = makeHarness([serverError()]);
  await h.sup.ready;
  assert.equal(h.timers.filter((t) => !t.cleared).length, 1);
  await h.sup.stop();
  assert.equal(h.timers.filter((t) => !t.cleared).length, 0);
  assert.equal(h.created.length, 1);
});

test("stop() stops a running worker", async () => {
  const h = makeHarness([null]);
  await h.sup.ready;
  const w = h.sup.getWorker();
  await h.sup.stop();
  assert.equal(w.stopCalls, 1);
  assert.equal(h.sup.getWorker(), null);
});

test("stop() during an in-flight start stops the worker that registers meanwhile", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = makeHarness([() => gate.then(() => null)]);
  await h.flush();
  assert.equal(h.created.length, 1);
  const stopping = h.sup.stop();
  release();
  await stopping;
  await h.sup.ready;
  assert.equal(h.created[0].stopCalls, 1);
  assert.equal(h.started.length, 0, "a worker started during shutdown is not announced as running");
});

// ---- error log rate limit ------------------------------------------------------

test("error log: first error in full, repeats are summarised once a minute", () => {
  let t = 0;
  const l = createErrorLogLimiter({ every: 1000, summaryMs: 60_000, now: () => t });

  assert.deepEqual(l.report("frames", "error: boom"), ["error: boom"]);
  let printed = 0;
  for (t = 1000; t < 60_000; t += 1000) printed += l.report("frames", "error: boom").length;
  assert.equal(printed, 0, "no line per poll during the first minute");

  t = 60_000;
  const lines = l.report("frames", "error: boom");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /60 more error\(s\) suppressed/);
  assert.match(lines[0], /error: boom/);
});

test("error log: every Nth repeat is printed in full", () => {
  let t = 0;
  const l = createErrorLogLimiter({ every: 5, summaryMs: 60_000, now: () => t });
  const out = [];
  for (let i = 1; i <= 10; i++) {
    t += 1000;
    out.push(...l.report("a", `error: ${i}`));
  }
  assert.equal(out.length, 3);
  assert.equal(out[0], "error: 1");
  assert.match(out[1], /^error: 5 \(5 errors since the first\)$/);
  assert.match(out[2], /^error: 10 \(10 errors since the first\)$/);
});

test("error log: workers are counted separately and a quiet minute resets", () => {
  let t = 0;
  const l = createErrorLogLimiter({ every: 1000, summaryMs: 60_000, now: () => t });
  assert.equal(l.report("frames", "x").length, 1);
  assert.equal(l.report("assemble", "x").length, 1);
  assert.equal(l.report("frames", "x").length, 0);

  t = 200_000; // outage over: the next error is "first" again, with a pending count
  const lines = l.report("frames", "x");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /1 earlier repeat/);
  assert.equal(lines[1], "x");
});
