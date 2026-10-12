/**
 * Worker start supervision.
 *
 * `SpooledWorker.start()` registers the worker with the API and refuses a
 * second start once it has failed (state "error"), so a start that failed on a
 * 5xx, a timeout or a network error needs a NEW worker instance for the next
 * try. `superviseWorker` takes a factory for that, retries in the background
 * with backoff and reports the state for /health.
 */

/** Retry timing: fast exponential backoff for transient errors, slow for the rest. */
export const WORKER_START_RETRY = Object.freeze({
  baseMs: 2_000,
  maxMs: 60_000,
  // Quota (plan worker cap) and other 4xx answers do not clear on their own in
  // seconds, but a plan upgrade or a freed slot should be picked up without a
  // restart, so they are retried slowly rather than never.
  slowMs: 5 * 60_000,
});

/** Workers a Forge cannot run without (the public schedule worker is optional). */
export const REQUIRED_WORKERS = Object.freeze(["frames", "assemble"]);

/**
 * "quota"     plan limit (429 QUOTA_EXCEEDED): retried slowly
 * "rejected"  other 4xx the API will keep answering (bad key, no permission): slowly
 * "transient" 5xx, timeout, network, circuit breaker, plain 429: backoff
 */
export function classifyStartError(err) {
  if (err?.isQuota) return "quota";
  const status = Number(err?.statusCode) || 0;
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return "rejected";
  }
  return "transient";
}

/** Delay before the next start attempt after `failures` consecutive failures. */
export function startRetryDelayMs(
  kind,
  failures,
  retry = WORKER_START_RETRY,
  random = Math.random,
) {
  if (kind !== "transient") return retry.slowMs;
  const exp = Math.min(
    retry.maxMs,
    retry.baseMs * 2 ** Math.max(0, failures - 1),
  );
  // Jitter downwards only, so the cap holds.
  return Math.round(exp * (0.75 + 0.25 * random()));
}

/**
 * True when the API refused a caller-supplied worker id: worker ids are a
 * global primary key, so an id held by another organization answers 409
 * (message "This worker_id cannot be used: ..."; older builds said "Worker ID
 * already in use"). Registering without an id gets a generated one.
 */
export function isWorkerIdUnavailable(err) {
  if (!err) return false;
  if (err.code === "WORKER_ID_UNAVAILABLE") return true;
  return (
    Number(err.statusCode) === 409 &&
    /worker[ _]?id/i.test(String(err.message || ""))
  );
}

/** Names of the required workers that are not in state "running". */
export function missingWorkers(states, required = REQUIRED_WORKERS) {
  return required.filter((name) => states?.[name] !== "running");
}

/**
 * Start a worker and keep trying until it runs or `stop()` is called.
 *
 * - `create({ useServerId })` must return a NEW worker with its handler set;
 *   `useServerId` true means "omit workerId" (after a 409 on the stable id).
 * - `ready` resolves when the FIRST attempt has settled (started, or failed
 *   and a retry is scheduled), so callers can start workers one after the
 *   other (the first gets the scarce plan slot) without waiting for retries.
 * - States passed to `onState`: "starting", "running", "quota_exceeded",
 *   "failed: <message>".
 */
export function superviseWorker({
  name,
  create,
  onState = () => {},
  onStarted = () => {},
  log = console,
  retry = WORKER_START_RETRY,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  stopWaitMs = 5_000,
}) {
  let failures = 0;
  let useServerId = false;
  let stopped = false;
  let timer = null;
  let current = null;
  let inflight = null;

  onState("starting");

  async function attempt() {
    timer = null;
    if (stopped) return;
    let worker;
    for (;;) {
      try {
        worker = create({ useServerId });
        await worker.start();
        break;
      } catch (err) {
        if (stopped) return;
        if (!useServerId && isWorkerIdUnavailable(err)) {
          useServerId = true;
          log.warn(
            `[worker:${name}] worker id refused by the API (${err?.message || err}); ` +
              "registering without a workerId so the server generates one",
          );
          continue;
        }
        failures++;
        const kind = classifyStartError(err);
        const delay = startRetryDelayMs(kind, failures, retry, random);
        const reason = err?.message || String(err);
        onState(kind === "quota" ? "quota_exceeded" : `failed: ${reason}`);
        log.error(
          `[worker:${name}] could not start (attempt ${failures}${
            kind === "quota" ? ", plan limit" : ""
          }): ${reason} -- retrying in ${Math.round(delay / 1000)}s`,
        );
        timer = setTimer(() => {
          inflight = run();
        }, delay);
        return;
      }
    }

    if (stopped) {
      await worker.stop().catch(() => {});
      return;
    }
    failures = 0;
    current = worker;
    onState("running");
    onStarted(worker);
  }

  // attempt() handles every start error itself; this only keeps a bug in a
  // callback from becoming an unhandled rejection that takes the process down.
  const run = () =>
    attempt().catch((err) => {
      log.error(`[worker:${name}] supervisor error: ${err?.message || err}`);
    });

  inflight = run();
  const ready = inflight;

  /** Stop retrying and stop the running worker (drains its jobs). */
  async function stop() {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (inflight) {
      // A start request may be on the wire: let it settle (its own branch
      // stops the worker it registered) but never hold shutdown for long.
      let waitTimer;
      await Promise.race([
        inflight.catch(() => {}),
        new Promise((resolve) => {
          waitTimer = setTimeout(resolve, stopWaitMs);
          waitTimer.unref?.();
        }),
      ]);
      clearTimeout(waitTimer);
    }
    if (current) {
      const w = current;
      current = null;
      await w.stop();
    }
  }

  return { ready, stop, getWorker: () => current };
}

/**
 * Rate-limits a repeating error log (a worker polls every second, so an API
 * outage would print one line per worker per second).
 *
 * `report(key, message)` returns the lines to print now:
 * - the first error of an outage, in full;
 * - every `every`th repeat, in full;
 * - otherwise nothing, except one summary line per `summaryMs` saying how
 *   many were suppressed.
 * An outage ends after `summaryMs` without an error; the next error is then
 * "first" again (and a pending suppressed count is reported with it).
 */
export function createErrorLogLimiter({
  every = 100,
  summaryMs = 60_000,
  now = Date.now,
} = {}) {
  const states = new Map();
  return {
    report(key, message) {
      const t = now();
      const lines = [];
      let s = states.get(key);
      if (s && t - s.lastAt > summaryMs) {
        if (s.suppressed > 0) {
          lines.push(
            `${s.suppressed} earlier repeat(s) of the last error were suppressed`,
          );
        }
        s = undefined;
      }
      if (!s) {
        states.set(key, { count: 1, suppressed: 0, lastAt: t, lastSummaryAt: t });
        lines.push(message);
        return lines;
      }
      s.count++;
      s.lastAt = t;
      if (s.count % every === 0) {
        lines.push(`${message} (${s.count} errors since the first)`);
      } else {
        s.suppressed++;
        if (t - s.lastSummaryAt >= summaryMs) {
          lines.push(
            `${s.suppressed} more error(s) suppressed in the last ${Math.round(
              (t - s.lastSummaryAt) / 1000,
            )}s (${s.count} since the first); latest: ${message}`,
          );
          s.suppressed = 0;
          s.lastSummaryAt = t;
        }
      }
      return lines;
    },
  };
}
