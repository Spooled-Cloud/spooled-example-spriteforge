import crypto from "node:crypto";
import path from "node:path";

/** Session ids are minted by the browser (crypto.randomUUID) or the server. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** True for a bounded, url-safe session id (the shape the SSE endpoint keeps). */
export function isValidSessionId(raw) {
  return typeof raw === "string" && SESSION_ID_RE.test(raw);
}

/**
 * Why a client-supplied sessionId is unusable, or null when it is fine
 * (400 `missing_session_id` / `invalid_session_id` on /api/forge and
 * /api/jobs/batch: the id ends up in workflow names, payloads and metadata).
 */
export function sessionIdProblem(raw) {
  if (raw == null || raw === "") return "missing_session_id";
  return isValidSessionId(raw) ? null : "invalid_session_id";
}

/** Return `raw` when it is a plausible session id, otherwise `fallback()`. */
export function normalizeSessionId(raw, fallback) {
  return isValidSessionId(raw) ? raw : fallback();
}

/**
 * TRUST_PROXY: on unless explicitly switched off. Blank / unset keeps the
 * default (on); false, 0, no and off (trimmed, any case) turn it off.
 */
export function parseTrustProxy(raw) {
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(v);
}

/**
 * Integer env var with a default. Blank, non-numeric and below-`min` values
 * fall back to `fallback`, so compose can pass a variable through empty
 * (`FOO: ${FOO:-}`) and still get the code default.
 */
export function parseIntEnv(raw, fallback, min = 1) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * Worker ids are a global primary key across organizations, so the default
 * prefix must differ per organization: derive it from the API key (8 hex of
 * its sha256, never the key itself). Two apps with different keys can never
 * collide; a restart with the same key reuses its rows.
 */
export function defaultWorkerIdPrefix(apiKey) {
  const h = crypto.createHash("sha256").update(String(apiKey)).digest("hex");
  return `spriteforge-${h.slice(0, 8)}`;
}

/** WORKER_ID_PREFIX when set (sanitized), otherwise the per-key default. */
export function resolveWorkerIdPrefix(raw, apiKey) {
  const v = raw == null ? "" : String(raw).trim();
  if (!v) return defaultWorkerIdPrefix(apiKey);
  return v.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
}

const FEATURE_DISABLED_MESSAGE = /^(.+?) is not available on the (.+?) plan\b/i;

/**
 * A plan that does not include a feature answers 403 `feature_disabled`
 * (Free + workflows). The SDK keeps only `body.code`, which older API builds
 * do not send (the app then saw UNKNOWN_ERROR), so also recognise the message.
 * Returns `{ feature, plan, message }` or null.
 */
export function featureDisabledInfo(err) {
  if (!err || Number(err.statusCode) !== 403) return null;
  const message = String(err.message || "");
  const m = FEATURE_DISABLED_MESSAGE.exec(message);
  if (err.code !== "FEATURE_DISABLED" && !m) return null;
  return {
    feature: m ? m[1] : null,
    plan: m ? m[2].toLowerCase() : null,
    message,
  };
}

/**
 * Client IP for rate limiting. With `trustProxy` (default, for Cloudflare /
 * ingress deployments) the proxy headers win; without it only the socket
 * address counts, so a directly exposed server cannot be told a fake IP.
 */
export function getClientIp(req, trustProxy = true) {
  const header = (name) => {
    const v = req.headers[name];
    if (Array.isArray(v)) return v[0];
    if (typeof v === "string" && v.length > 0) return v;
    return null;
  };

  let ip = null;
  if (trustProxy) {
    const xff = header("x-forwarded-for");
    ip =
      header("cf-connecting-ip") ||
      header("x-real-ip") ||
      (xff ? xff.split(",")[0].trim() : null);
  }
  ip = ip || req.socket?.remoteAddress || "unknown";

  // Normalize IPv6-mapped IPv4 addresses (e.g. ::ffff:127.0.0.1)
  if (typeof ip === "string" && ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

/** True when `full` is `base` itself or lives below it (separator-aware). */
export function isInsideDir(base, full) {
  const rel = path.relative(base, full);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Caps concurrent SSE clients per process and per IP.
 * `acquire(ip)` returns `{ ok: true, release }` or
 * `{ ok: false, status, code, message }` (503 at the process cap, 429 per IP).
 */
export function createSseLimiter({ maxClients = 500, maxPerIp = 10 } = {}) {
  let total = 0;
  /** @type {Map<string, number>} */
  const perIp = new Map();

  return {
    acquire(ip) {
      if (total >= maxClients) {
        return {
          ok: false,
          status: 503,
          code: "sse_capacity",
          message: "Too many live connections on this server, try again shortly",
        };
      }
      const n = perIp.get(ip) || 0;
      if (n >= maxPerIp) {
        return {
          ok: false,
          status: 429,
          code: "sse_per_ip_limit",
          message: "Too many live connections from your address",
        };
      }
      total++;
      perIp.set(ip, n + 1);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          total--;
          const left = (perIp.get(ip) || 1) - 1;
          if (left <= 0) perIp.delete(ip);
          else perIp.set(ip, left);
        },
      };
    },
    stats() {
      return { clients: total, ips: perIp.size, maxClients, maxPerIp };
    },
  };
}

/**
 * Content-Security-Policy for the bundled UI (public/). The page runs one
 * module script from this origin, one stylesheet from this origin plus the
 * Google Fonts stylesheet and font files, and talks only to this server
 * (fetch + EventSource); it has no inline script, inline style or iframe.
 * Cloudflare Web Analytics, when the zone injects its beacon at the edge, is
 * allowed too (script from static.cloudflareinsights.com, reports to
 * cloudflareinsights.com); without it every page load logged a CSP violation
 * and the zone's analytics silently stopped for this site.
 * Everything else is closed, and no other site may frame it.
 */
export const DEFAULT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self'",
  "connect-src 'self' https://cloudflareinsights.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * CONTENT_SECURITY_POLICY: blank / unset keeps the default policy; off, false,
 * 0, no or none (any case) send no CSP header (for a proxy that sets its own);
 * any other value replaces the policy. A value Node cannot send as a header
 * (control or non-ASCII characters) falls back to the default instead of
 * failing every request. Returns the policy string, or null for "no header".
 */
export function resolveContentSecurityPolicy(raw) {
  if (raw == null) return DEFAULT_CONTENT_SECURITY_POLICY;
  const v = String(raw).trim();
  if (!v) return DEFAULT_CONTENT_SECURITY_POLICY;
  if (["off", "false", "0", "no", "none"].includes(v.toLowerCase())) {
    return null;
  }
  return /^[\x20-\x7e]+$/.test(v) ? v : DEFAULT_CONTENT_SECURITY_POLICY;
}

/**
 * Headers every response carries: no framing (clickjacking), no MIME
 * sniffing, a trimmed Referer, and the browser features the page never uses
 * switched off. `csp` is the policy string or null (no Content-Security-Policy).
 */
export function securityHeaders(csp = DEFAULT_CONTENT_SECURITY_POLICY) {
  const headers = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  if (csp) headers["Content-Security-Policy"] = csp;
  return headers;
}
