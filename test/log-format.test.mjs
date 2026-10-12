import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  esc,
  jobFailedLine,
  statusTransitionLine,
} from "../public/log-format.js";

const APP_JS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js"),
  "utf8",
);

const PAYLOAD = '<img src=x onerror="alert(1)">';

test("esc: HTML-significant characters never survive", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
});

// innerHTML sink: a failing job's error text is whatever the handler threw and
// the job key comes from the API, so neither may reach the log as markup.
test("job.failed log line escapes the key and the error text", () => {
  const html = jobFailedLine({
    key: PAYLOAD,
    error: `<script>alert(1)</script> ${PAYLOAD}`,
    retryCount: 1,
    willRetry: true,
  });
  assert.ok(!html.includes("<img"), html);
  assert.ok(!html.includes("<script"), html);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), html);
  // the markup the app itself adds is intact
  assert.ok(html.includes('<span class="event-retry">FAILED</span>'));
  assert.ok(html.includes("<code>&lt;img"));
  assert.ok(html.includes("(retry #2)"));
});

test("job.failed log line: final failure, missing key / error, junk retry count", () => {
  assert.equal(
    jobFailedLine({ key: "frame-3", error: "boom", retryCount: 5, willRetry: false }),
    '❌ <span class="event-failed">FAILED</span> <code>frame-3</code> — boom (no more retries)',
  );
  const html = jobFailedLine({ retryCount: "<b>", willRetry: true });
  assert.ok(html.includes("<code>?</code> — unknown error (retry #1)"), html);
});

test("status label line escapes the status names too", () => {
  const html = statusTransitionLine("frame-1", PAYLOAD, "<b>x</b>");
  assert.ok(!html.includes("<img") && !html.includes("<b>"), html);
  assert.equal(
    statusTransitionLine("frame-1", "pending", "processing"),
    "🔁 Status: <code>frame-1</code> pending → <strong>processing</strong>",
  );
});

// logLine() sets innerHTML; app.js has to build these two lines through the
// escaping helpers instead of interpolating meta.key / data.error itself.
test("app.js builds the job.failed and status lines with the escaping helpers", () => {
  assert.match(APP_JS, /import \{[^}]*jobFailedLine[^}]*\} from '\.\/log-format\.js'/);
  assert.match(APP_JS, /import \{[^}]*statusTransitionLine[^}]*\} from '\.\/log-format\.js'/);
  assert.ok(APP_JS.includes("jobFailedLine({"));
  assert.ok(APP_JS.includes("statusTransitionLine(label, oldStatus, newStatus)"));
  assert.ok(!/<code>\$\{meta\.key/.test(APP_JS), "raw meta.key in a log line");
  assert.ok(!/\$\{data\.error/.test(APP_JS), "raw data.error in a log line");
  assert.ok(!/\$\{oldStatus\}|\$\{newStatus\}/.test(APP_JS), "raw status in a log line");
});
