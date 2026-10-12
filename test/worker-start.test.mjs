import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { startApp, waitUntil } from "./helpers/app.mjs";
import { startMockSpooled } from "./helpers/mock-spooled.mjs";

const SESSION = "123e4567-e89b-12d3-a456-426614174000";
const stoppers = [];
after(async () => {
  for (const stop of stoppers) await stop();
});

async function boot(mockOptions) {
  const mock = await startMockSpooled(mockOptions);
  stoppers.push(() => mock.close());
  const app = await startApp(mock.url);
  stoppers.push(() => app.stop());
  return { mock, app };
}

// These boot a real server against the in-process API; they run side by side.
describe("worker start failures", { concurrency: true }, () => {
  // The first 3 register calls (one per worker, the SDK does not retry a
  // register) answer 503, so the workers only come up through OUR retry on a
  // new SpooledWorker. Before the fix they stayed "failed: ..." until a restart.
  it("a transient start failure (503) is retried until the workers run", async () => {
    const { mock, app } = await boot({ failRegisters: 3 });

    const early = await app.health();
    assert.equal(early.status, 503);
    assert.equal(early.body.ok, false);
    assert.deepEqual(early.body.missingWorkers, ["frames", "assemble"]);
    assert.notEqual(early.body.workers.frames, "running");

    const forge = await app.post("/api/forge", { sessionId: SESSION, seed: "early" });
    assert.equal(forge.status, 503, JSON.stringify(forge.body));
    assert.equal(forge.body.error, "workers_unavailable");
    assert.match(forge.body.message, /frames/);
    assert.equal(forge.headers.get("retry-after"), "15");
    assert.ok(!mock.calls.includes("POST /api/v1/workflows"), "no workflow created while workers are down");

    const healthy = await waitUntil(async () => {
      const h = await app.health();
      return h.status === 200 && h.body.workers.public === "running" ? h : null;
    }, { ms: 30000 });
    assert.equal(healthy.body.ok, true);
    assert.deepEqual(healthy.body.workers, { frames: "running", assemble: "running", public: "running" });

    for (const queue of ["frames", "assemble", "public"]) {
      const tries = mock.registers.filter((r) => r.queue === `spriteforge-${queue}`);
      assert.equal(tries.length, 2, `${queue} registered ${tries.length} times`);
    }
    assert.ok(
      app.logs().includes("[worker:frames] could not start (attempt 1)"),
      "the failed first attempt is logged",
    );

    const ok = await app.post("/api/forge", { sessionId: SESSION, seed: "late", frameCount: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("a 409 on the stable worker id falls back to a generated one, logged once per worker", async () => {
    const { mock, app } = await boot({ conflictWorkerIds: true });
    await waitUntil(async () => {
      const h = await app.health();
      return h.status === 200 && h.body.workers.public === "running";
    });

    for (const queue of ["frames", "assemble", "public"]) {
      const tries = mock.registers.filter((r) => r.queue === `spriteforge-${queue}`);
      assert.equal(tries.length, 2, `${queue}: ${JSON.stringify(tries)}`);
      assert.match(tries[0].workerId, /^spriteforge-[0-9a-f]{8}-/);
      assert.equal(tries[1].workerId, null, "second try registers without a workerId");
      const logged = app.logs().split("\n").filter((l) => l.includes(`[worker:${queue}]`) && l.includes("without a workerId"));
      assert.equal(logged.length, 1, `${queue} fallback logged ${logged.length} times`);
    }
  });

  it("a plan limit leaves frames running, reports the rest, and is not hammered", async () => {
    const { mock, app } = await boot({ mode: "quota_workers" });
    const h = await waitUntil(async () => {
      const r = await app.health();
      return r.body.workers.public === "quota_exceeded" ? r : null;
    });
    assert.equal(h.status, 503);
    assert.equal(h.body.workers.frames, "running");
    assert.equal(h.body.workers.assemble, "quota_exceeded");
    assert.deepEqual(h.body.missingWorkers, ["assemble"]);

    const forge = await app.post("/api/forge", { sessionId: SESSION, seed: "quota" });
    assert.equal(forge.status, 503);
    assert.equal(forge.body.error, "workers_unavailable");
    assert.match(forge.body.message, /assemble/);
    assert.match(forge.body.message, /worker limit/);

    const before = mock.registers.length;
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(mock.registers.length, before, "quota refusals are retried slowly, not every few seconds");
  });
});
