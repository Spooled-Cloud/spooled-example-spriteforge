// A small in-process stand-in for the Spooled REST API: just enough for
// SpriteForge to register workers, create a workflow and run its jobs.
// Test-only; never talks to a real Spooled deployment.
import http from "node:http";
import crypto from "node:crypto";

/**
 * options:
 *  - mode: "ok" | "free_workflow" (POST /workflows answers 403 feature_disabled
 *    without a `code`, like older API builds) | "quota_workers" (only the first
 *    worker registers, the rest get 429 QUOTA_EXCEEDED)
 *  - failRegisters: the first N register calls answer 503
 *  - conflictWorkerIds: a register that names a worker_id answers 409
 */
export async function startMockSpooled(options = {}) {
  const state = {
    mode: options.mode || "ok",
    failRegisters: options.failRegisters || 0,
    conflictWorkerIds: Boolean(options.conflictWorkerIds),
  };
  const jobs = new Map();
  const registers = [];
  const calls = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = req.url.split("?")[0];
      let b = {};
      try {
        b = body ? JSON.parse(body) : {};
      } catch {
        // not JSON: leave empty
      }
      calls.push(`${req.method} ${u}`);
      const json = (code, obj) => {
        const t = JSON.stringify(obj);
        res.writeHead(code, { "content-type": "application/json" });
        res.end(t);
      };
      let m;

      if (u === "/api/v1/workers/register") {
        registers.push({ queue: b.queue_name, workerId: b.worker_id ?? null });
        if (registers.length <= state.failRegisters) {
          return json(503, { code: "SERVICE_UNAVAILABLE", message: "maintenance" });
        }
        if (state.conflictWorkerIds && b.worker_id) {
          return json(409, {
            code: "CONFLICT",
            message:
              "This worker_id cannot be used: register with a different worker_id, or omit it to get a generated one",
          });
        }
        if (state.mode === "quota_workers" && registers.length > 1) {
          return json(429, {
            error: "limit_exceeded",
            code: "QUOTA_EXCEEDED",
            message: "workers limit reached (1/1)",
          });
        }
        return json(201, {
          id: b.worker_id || `generated-${registers.length}`,
          queue_name: b.queue_name,
          lease_duration_secs: 30,
          heartbeat_interval_secs: 10,
        });
      }
      if (/\/workers\/.*\/(heartbeat|deregister)$/.test(u)) {
        res.writeHead(204);
        return res.end();
      }
      if (u === "/api/v1/queues") return json(200, []);
      if (u === "/api/v1/schedules" && req.method === "GET") return json(200, []);
      if (u === "/api/v1/schedules" && req.method === "POST") {
        return json(201, { id: crypto.randomUUID(), name: b.name, next_run_at: null });
      }
      if (u === "/api/v1/auth/login") {
        return json(200, { access_token: "a.b.c", refresh_token: "r", expires_in: 86400, token_type: "Bearer" });
      }
      if (u === "/api/v1/workflows" && req.method === "POST") {
        if (state.mode === "free_workflow") {
          return json(403, {
            error: "feature_disabled",
            message: "workflows is not available on the Free plan. Upgrade to unlock this feature.",
            feature: "workflows",
            plan: "free",
            upgrade_to: "starter",
          });
        }
        const idByKey = {};
        for (const j of b.jobs) idByKey[j.key] = crypto.randomUUID();
        for (const j of b.jobs) {
          jobs.set(idByKey[j.key], {
            id: idByKey[j.key],
            key: j.key,
            queue_name: j.queue_name,
            payload: j.payload,
            status: "pending",
            retry_count: 0,
            max_retries: j.max_retries ?? 3,
            timeout_seconds: j.timeout_seconds ?? 30,
            deps: (j.depends_on || []).map((k) => idByKey[k]),
            result: null,
            lease_id: null,
          });
        }
        return json(201, {
          workflow_id: crypto.randomUUID(),
          job_ids: b.jobs.map((j) => ({ key: j.key, job_id: idByKey[j.key] })),
        });
      }
      if (u === "/api/v1/jobs/claim") {
        const out = [];
        for (const j of jobs.values()) {
          if (out.length >= (b.limit || 1)) break;
          if (j.queue_name !== b.queue_name || j.status !== "pending") continue;
          if (!j.deps.every((d) => jobs.get(d).status === "completed")) continue;
          j.status = "processing";
          j.lease_id = crypto.randomUUID();
          out.push({
            id: j.id,
            queue_name: j.queue_name,
            payload: j.payload,
            retry_count: j.retry_count,
            max_retries: j.max_retries,
            timeout_seconds: j.timeout_seconds,
            lease_id: j.lease_id,
          });
        }
        return json(200, { jobs: out });
      }
      if ((m = /^\/api\/v1\/jobs\/([^/]+)\/complete$/.exec(u))) {
        const j = jobs.get(m[1]);
        j.status = "completed";
        j.result = b.result;
        return json(200, { success: true });
      }
      if ((m = /^\/api\/v1\/jobs\/([^/]+)\/fail$/.exec(u))) {
        const j = jobs.get(m[1]);
        j.retry_count++;
        j.status = j.retry_count > j.max_retries ? "deadletter" : "pending";
        return json(200, { success: true });
      }
      if ((m = /^\/api\/v1\/jobs\/([^/]+)\/dependencies$/.exec(u))) {
        const j = jobs.get(m[1]);
        return json(200, {
          job_id: j.id,
          dependencies: j.deps.map((d) => ({
            job_id: d,
            queue_name: jobs.get(d).queue_name,
            status: jobs.get(d).status,
          })),
          dependents: [],
          dependencies_met: true,
        });
      }
      if ((m = /^\/api\/v1\/jobs\/([^/]+)$/.exec(u))) {
        const j = jobs.get(m[1]);
        if (!j) return json(404, { code: "NOT_FOUND", message: "no such job" });
        return json(200, {
          id: j.id,
          queue_name: j.queue_name,
          status: j.status,
          payload: j.payload,
          result: j.result,
          retry_count: j.retry_count,
          max_retries: j.max_retries,
        });
      }
      json(404, { code: "NOT_FOUND", message: `no ${u}` });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    registers,
    calls,
    jobs,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
