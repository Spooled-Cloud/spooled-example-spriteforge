import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";

import {
  createSseLimiter,
  defaultWorkerIdPrefix,
  featureDisabledInfo,
  getClientIp,
  isInsideDir,
  normalizeSessionId,
  parseIntEnv,
  parseTrustProxy,
  resolveWorkerIdPrefix,
  sessionIdProblem,
} from "../server/guards.mjs";

test("SSE limiter: per-IP cap answers 429, release frees the slot", () => {
  const l = createSseLimiter({ maxClients: 100, maxPerIp: 2 });
  const a = l.acquire("1.1.1.1");
  const b = l.acquire("1.1.1.1");
  assert.ok(a.ok && b.ok);
  const c = l.acquire("1.1.1.1");
  assert.equal(c.ok, false);
  assert.equal(c.status, 429);
  assert.equal(l.acquire("2.2.2.2").ok, true);
  a.release();
  a.release(); // idempotent
  assert.equal(l.acquire("1.1.1.1").ok, true);
  assert.equal(l.stats().clients, 3);
});

test("SSE limiter: process cap answers 503", () => {
  const l = createSseLimiter({ maxClients: 2, maxPerIp: 10 });
  const a = l.acquire("a");
  l.acquire("b");
  const r = l.acquire("c");
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  a.release();
  assert.equal(l.acquire("c").ok, true);
});

test("session ids: only bounded url-safe ids are kept", () => {
  const mint = () => "minted";
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(normalizeSessionId(uuid, mint), uuid);
  assert.equal(normalizeSessionId("x".repeat(65), mint), "minted");
  assert.equal(normalizeSessionId("short", mint), "minted");
  assert.equal(normalizeSessionId("a b<script>aaaa", mint), "minted");
  assert.equal(normalizeSessionId(null, mint), "minted");
});

test("client ip: proxy headers only count when TRUST_PROXY is on", () => {
  const req = {
    headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    socket: { remoteAddress: "::ffff:10.1.1.1" },
  };
  assert.equal(getClientIp(req, true), "9.9.9.9");
  assert.equal(getClientIp(req, false), "10.1.1.1");
});

test("public dir check is separator-aware", () => {
  const base = path.resolve("/srv/app/public");
  assert.equal(isInsideDir(base, path.join(base, "app.js")), true);
  assert.equal(isInsideDir(base, base), true);
  assert.equal(isInsideDir(base, path.resolve("/srv/app/public-secret/x")), false);
  assert.equal(isInsideDir(base, path.resolve("/srv/app/other")), false);
});

test("TRUST_PROXY: only an explicit off turns it off (trimmed, any case)", () => {
  for (const off of ["false", "FALSE", " False ", "0", "no", "No", "off", "OFF", "  off\n"]) {
    assert.equal(parseTrustProxy(off), false, JSON.stringify(off));
  }
  for (const on of [undefined, null, "", "  ", "true", "1", "yes", "on", "garbage"]) {
    assert.equal(parseTrustProxy(on), true, JSON.stringify(on));
  }
});

test("integer env vars: blank / junk / below the minimum keep the default", () => {
  assert.equal(parseIntEnv(undefined, 30, 1), 30);
  assert.equal(parseIntEnv("", 30, 1), 30);
  assert.equal(parseIntEnv("  ", 30, 1), 30);
  assert.equal(parseIntEnv("abc", 30, 1), 30);
  assert.equal(parseIntEnv("0", 30, 1), 30);
  assert.equal(parseIntEnv("-4", 30, 1), 30);
  assert.equal(parseIntEnv(" 7 ", 30, 1), 7);
  assert.equal(parseIntEnv("7.9", 30, 1), 7);
  assert.equal(parseIntEnv("0", 20000, 0), 0);
});

test("worker id prefix: default is per API key, never a shared constant", () => {
  const key = "sp_live_example_key_one";
  const hex = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  assert.equal(defaultWorkerIdPrefix(key), `spriteforge-${hex}`);
  assert.match(defaultWorkerIdPrefix(key), /^spriteforge-[0-9a-f]{8}$/);
  assert.notEqual(defaultWorkerIdPrefix(key), defaultWorkerIdPrefix("sp_live_example_key_two"));
  assert.notEqual(defaultWorkerIdPrefix(key), "spriteforge");
  assert.ok(!defaultWorkerIdPrefix(key).includes(key));
});

test("worker id prefix: blank uses the default, an explicit value is sanitized", () => {
  const key = "sp_live_example_key_one";
  for (const blank of [undefined, "", "   "]) {
    assert.equal(resolveWorkerIdPrefix(blank, key), defaultWorkerIdPrefix(key));
  }
  assert.equal(resolveWorkerIdPrefix(" demo eu/1 ", key), "demo-eu-1");
  assert.equal(resolveWorkerIdPrefix("x".repeat(300), key).length, 100);
});

test("sessionId on forge / batch: missing and malformed are told apart", () => {
  assert.equal(sessionIdProblem(undefined), "missing_session_id");
  assert.equal(sessionIdProblem(""), "missing_session_id");
  assert.equal(sessionIdProblem("123e4567-e89b-12d3-a456-426614174000"), null);
  assert.equal(sessionIdProblem("short"), "invalid_session_id");
  assert.equal(sessionIdProblem("x".repeat(65)), "invalid_session_id");
  assert.equal(sessionIdProblem("a b<script>aaaa"), "invalid_session_id");
  assert.equal(sessionIdProblem(12345678), "invalid_session_id");
  assert.equal(sessionIdProblem({ toString: () => "validsession1" }), "invalid_session_id");
});

test("feature_disabled: recognised by code or by message, only on 403", () => {
  const fromMessage = featureDisabledInfo({
    statusCode: 403,
    code: "UNKNOWN_ERROR",
    message: "workflows is not available on the Free plan. Upgrade to unlock this feature.",
  });
  assert.deepEqual(fromMessage, {
    feature: "workflows",
    plan: "free",
    message: "workflows is not available on the Free plan. Upgrade to unlock this feature.",
  });
  const fromCode = featureDisabledInfo({ statusCode: 403, code: "FEATURE_DISABLED", message: "nope" });
  assert.equal(fromCode.feature, null);
  assert.equal(featureDisabledInfo({ statusCode: 403, code: "ACCESS_DENIED", message: "Access denied" }), null);
  assert.equal(
    featureDisabledInfo({ statusCode: 429, code: "QUOTA_EXCEEDED", message: "workflows limit reached (5/5)" }),
    null,
  );
  assert.equal(featureDisabledInfo(null), null);
});
