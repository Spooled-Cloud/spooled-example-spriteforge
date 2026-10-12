import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONTENT_SECURITY_POLICY,
  resolveContentSecurityPolicy,
  securityHeaders,
} from "../server/guards.mjs";
import { startApp } from "./helpers/app.mjs";

const PUBLIC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);
const read = (name) => readFileSync(path.join(PUBLIC_DIR, name), "utf8");

// The API is unreachable on purpose: the UI, /health and the SSE endpoint all
// answer without it (/health is 503 then, which is fine for these checks).
const DEAD_API = "http://127.0.0.1:9";

const stoppers = [];
after(() => stoppers.forEach((stop) => stop()));
async function app(env = {}) {
  const a = await startApp(DEAD_API, env);
  stoppers.push(a.stop);
  return a;
}

/** One raw HTTP/1.1 exchange: the status line, the headers and every body byte. */
function raw(port, method, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    socket.on("connect", () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("close", () => {
      const buf = Buffer.concat(chunks);
      const end = buf.indexOf("\r\n\r\n");
      const head = buf.subarray(0, end).toString("latin1").split("\r\n");
      const headers = {};
      for (const line of head.slice(1)) {
        const i = line.indexOf(":");
        headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({
        status: Number(head[0].split(" ")[1]),
        headers,
        body: buf.subarray(end + 4),
      });
    });
  });
}

// ---- HEAD ----------------------------------------------------------------------

let main;
before(async () => {
  main = await app();
});

// Before the fix every HEAD answered 404 "Not found" (only GET was routed), so a
// monitor probing with HEAD saw the app as down.
for (const target of [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/robots.txt",
  "/favicon.ico",
  "/site.webmanifest",
  "/health",
]) {
  test(`HEAD ${target} answers like GET, without a body`, async () => {
    const get = await raw(main.port, "GET", target);
    const head = await raw(main.port, "HEAD", target);
    assert.notEqual(get.status, 404, `GET ${target} should exist`);
    assert.equal(head.status, get.status);
    assert.equal(head.headers["content-type"], get.headers["content-type"]);
    assert.equal(head.body.length, 0, "a HEAD response carries no body");
    assert.ok(get.body.length > 0);
    if (target !== "/health") {
      // Static files: the length a GET would send (the health JSON changes by the second).
      assert.equal(head.headers["content-length"], String(get.body.length));
      assert.equal(get.headers["content-length"], String(get.body.length));
    }
  });
}

test("HEAD on an unknown path is 404 like GET", async () => {
  const get = await raw(main.port, "GET", "/nope");
  const head = await raw(main.port, "HEAD", "/nope");
  assert.equal(get.status, 404);
  assert.equal(head.status, 404);
  assert.equal(head.body.length, 0);
});

test("HEAD /api/events answers like GET and does not hold a stream slot", async () => {
  const a = await app({ MAX_SSE_PER_IP: "1" });
  const base = `http://127.0.0.1:${a.port}`;
  // Three probes, one allowed stream: they must not count against the cap.
  for (let i = 0; i < 3; i++) {
    const head = await raw(a.port, "HEAD", "/api/events");
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-type"], "text/event-stream");
    assert.equal(head.body.length, 0);
    // Not a stream: the probe's "Connection: close" is honoured, no keep-alive.
    assert.notEqual(head.headers.connection, "keep-alive");
  }
  assert.equal((await a.health()).body.sse.clients, 0);

  const live = new AbortController();
  try {
    const stream = await fetch(`${base}/api/events`, { signal: live.signal });
    assert.equal(stream.status, 200);
    assert.equal((await a.health()).body.sse.clients, 1);
    // At the cap a HEAD gets the status a GET would get.
    const head = await raw(a.port, "HEAD", "/api/events");
    const get = await fetch(`${base}/api/events`);
    assert.equal(get.status, 429);
    assert.equal(head.status, 429);
    assert.equal((await a.health()).body.sse.clients, 1);
  } finally {
    live.abort();
  }
});

test("POST-only routes still answer 404 to HEAD and to unknown methods", async () => {
  assert.equal((await raw(main.port, "HEAD", "/api/forge")).status, 404);
  assert.equal((await raw(main.port, "PUT", "/health")).status, 404);
  assert.equal((await raw(main.port, "DELETE", "/")).status, 404);
});

// ---- content types ---------------------------------------------------------------

test("static files are served with the right content type (nosniff is on)", async () => {
  const types = {
    "/site.webmanifest": /^application\/manifest\+json/,
    "/og.webp": /^image\/webp$/,
    "/robots.txt": /^text\/plain/,
    "/sitemap.xml": /^application\/xml/,
    "/favicon.svg": /^image\/svg\+xml$/,
    "/app.js": /^text\/javascript/,
    "/styles.css": /^text\/css/,
  };
  for (const [target, re] of Object.entries(types)) {
    const r = await raw(main.port, "GET", target);
    assert.equal(r.status, 200, target);
    assert.match(r.headers["content-type"], re, target);
  }
});

// ---- security headers --------------------------------------------------------------

function assertSecurityHeaders(headers, where) {
  assert.equal(headers["x-frame-options"], "DENY", `${where}: X-Frame-Options`);
  assert.equal(headers["x-content-type-options"], "nosniff", `${where}: nosniff`);
  assert.equal(
    headers["referrer-policy"],
    "strict-origin-when-cross-origin",
    `${where}: Referrer-Policy`,
  );
  assert.equal(
    headers["content-security-policy"],
    DEFAULT_CONTENT_SECURITY_POLICY,
    `${where}: Content-Security-Policy`,
  );
  assert.match(headers["permissions-policy"], /camera=\(\)/, `${where}: Permissions-Policy`);
}

// Before the fix none of these headers was sent at all.
test("every kind of response carries the security headers", async () => {
  const calls = [
    ["GET", "/"],
    ["HEAD", "/"],
    ["GET", "/app.js"],
    ["GET", "/health"],
    ["GET", "/nope"], // 404
    ["HEAD", "/api/events"], // 200 text/event-stream, no stream
  ];
  for (const [method, target] of calls) {
    const r = await raw(main.port, method, target);
    assertSecurityHeaders(r.headers, `${method} ${target} (${r.status})`);
  }

  // The event stream never ends, so look at its head through fetch.
  const live = new AbortController();
  try {
    const stream = await fetch(`http://127.0.0.1:${main.port}/api/events`, {
      signal: live.signal,
    });
    assert.equal(stream.status, 200);
    assertSecurityHeaders(Object.fromEntries(stream.headers), "SSE stream");
  } finally {
    live.abort();
  }

  // JSON error from a handler (invalid body) and the SSE cap answer.
  const bad = await main.post("/api/forge", "not an object");
  assert.equal(bad.status, 400);
  assertSecurityHeaders(Object.fromEntries(bad.headers), "POST /api/forge 400");
});

test("the SSE cap answer (429) carries the security headers", async () => {
  const a = await app({ MAX_SSE_PER_IP: "1" });
  const live = new AbortController();
  try {
    const first = await fetch(`http://127.0.0.1:${a.port}/api/events`, {
      signal: live.signal,
    });
    assert.equal(first.status, 200);
    const over = await raw(a.port, "GET", "/api/events");
    assert.equal(over.status, 429);
    assertSecurityHeaders(over.headers, "429");
  } finally {
    live.abort();
  }
});

test("CONTENT_SECURITY_POLICY: off sends none, a value replaces, blank keeps the default", async () => {
  const off = await app({ CONTENT_SECURITY_POLICY: "off" });
  const offHome = await raw(off.port, "GET", "/");
  assert.equal(offHome.status, 200);
  assert.equal(offHome.headers["content-security-policy"], undefined);
  assert.equal(offHome.headers["x-frame-options"], "DENY");

  const custom = await app({ CONTENT_SECURITY_POLICY: "default-src 'none'" });
  assert.equal(
    (await raw(custom.port, "GET", "/")).headers["content-security-policy"],
    "default-src 'none'",
  );

  const blank = await app({ CONTENT_SECURITY_POLICY: "  " });
  assert.equal(
    (await raw(blank.port, "GET", "/")).headers["content-security-policy"],
    DEFAULT_CONTENT_SECURITY_POLICY,
  );
});

// ---- the policy itself -------------------------------------------------------------

test("default policy: closed by default, no framing, no inline script or style", () => {
  const directives = Object.fromEntries(
    DEFAULT_CONTENT_SECURITY_POLICY.split("; ").map((d) => {
      const [name, ...values] = d.split(" ");
      return [name, values];
    }),
  );
  assert.deepEqual(directives["default-src"], ["'self'"]);
  assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["script-src"], ["'self'"]);
  assert.deepEqual(directives["connect-src"], ["'self'"]);
  assert.deepEqual(directives["base-uri"], ["'self'"]);
  assert.doesNotMatch(DEFAULT_CONTENT_SECURITY_POLICY, /unsafe-|\*/);
  assert.deepEqual(directives["style-src"], ["'self'", "https://fonts.googleapis.com"]);
  assert.deepEqual(directives["font-src"], ["'self'", "https://fonts.gstatic.com"]);
});

test("resolveContentSecurityPolicy: blank = default, off = none, value = value", () => {
  assert.equal(resolveContentSecurityPolicy(undefined), DEFAULT_CONTENT_SECURITY_POLICY);
  assert.equal(resolveContentSecurityPolicy(""), DEFAULT_CONTENT_SECURITY_POLICY);
  assert.equal(resolveContentSecurityPolicy("   "), DEFAULT_CONTENT_SECURITY_POLICY);
  for (const off of ["off", "OFF", " false ", "0", "no", "None"]) {
    assert.equal(resolveContentSecurityPolicy(off), null, off);
  }
  assert.equal(
    resolveContentSecurityPolicy(" default-src 'self' https://cdn.example "),
    "default-src 'self' https://cdn.example",
  );
  // A value Node would refuse to send must not take every response down.
  assert.equal(resolveContentSecurityPolicy("default-src 'self'\r\nX-Evil: 1"), DEFAULT_CONTENT_SECURITY_POLICY);
  assert.equal(resolveContentSecurityPolicy("default-src 'self' —"), DEFAULT_CONTENT_SECURITY_POLICY);
});

test("securityHeaders: the fixed headers, plus the policy when there is one", () => {
  const withCsp = securityHeaders();
  assert.equal(withCsp["X-Frame-Options"], "DENY");
  assert.equal(withCsp["X-Content-Type-Options"], "nosniff");
  assert.equal(withCsp["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(withCsp["Content-Security-Policy"], DEFAULT_CONTENT_SECURITY_POLICY);
  const without = securityHeaders(null);
  assert.equal("Content-Security-Policy" in without, false);
  assert.equal(without["X-Frame-Options"], "DENY");
});

// The page must keep satisfying the policy: these are the things a CSP without
// 'unsafe-inline' would silently break (the browser run in the release notes
// covers the rest).
test("the page needs no inline script, inline style or handler attribute", () => {
  const html = read("index.html").replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, "inline <script>");
  assert.doesNotMatch(html, /<style[\s>]/i, "<style> block");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "style= attribute");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "inline event handler");
  assert.doesNotMatch(html, /javascript:/i, "javascript: URL");
  for (const js of ["app.js", "log-format.js"]) {
    const src = read(js);
    assert.doesNotMatch(src, /\bstyle\s*=\s*\\?["']/, `${js}: style= in markup`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, `${js}: setAttribute('style')`);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(/, `${js}: eval / new Function`);
  }
  assert.doesNotMatch(read("styles.css"), /@import|url\(\s*["']?(https?:|data:)/i, "styles.css");
});

test("every cross-origin resource the page loads is allowed by the policy", () => {
  const html = read("index.html").replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  const loaded = [];
  for (const m of html.matchAll(/<(script|img|iframe)\b[^>]*\ssrc="([^"]+)"/gi)) {
    loaded.push(m[2]);
  }
  for (const m of html.matchAll(/<link\b[^>]*\shref="([^"]+)"[^>]*>/gi)) {
    // Navigation hints and metadata do not load anything the policy governs.
    if (/rel="(preconnect|canonical|dns-prefetch)"/.test(m[0])) continue;
    loaded.push(m[1]);
  }
  assert.ok(loaded.length > 5);
  const external = loaded.filter((u) => /^(https?:)?\/\//.test(u));
  assert.deepEqual(
    external.map((u) => new URL(u, "https://x").origin),
    ["https://fonts.googleapis.com"],
    "the only cross-origin load is the Google Fonts stylesheet",
  );
  assert.match(DEFAULT_CONTENT_SECURITY_POLICY, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(DEFAULT_CONTENT_SECURITY_POLICY, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
  // The stylesheet is switched on from app.js, not from an inline onload.
  assert.match(html, /<link\b[^>]*fonts\.googleapis\.com[^>]*\sdata-async-style/);
  assert.match(read("app.js"), /link\[data-async-style\][\s\S]{0,80}\.media\s*=\s*'all'/);
  // The form is kept from submitting by a listener, not an onsubmit attribute.
  assert.match(html, /<form\b[^>]*\bid="forge-form"/);
  assert.match(read("app.js"), /\$\('forge-form'\)\?\.addEventListener\('submit',\s*\(e\) => e\.preventDefault\(\)\)/);
});
