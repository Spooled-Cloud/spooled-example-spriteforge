/**
 * HTML for the Events log lines that carry server- or job-supplied text.
 *
 * `logLine()` sets innerHTML, and job keys, job error text and status names
 * come from the API / the worker (a failing job's `error` is whatever the
 * handler threw), so every dynamic value goes through `esc()` here. Kept in
 * its own module so node --test can cover it without a DOM.
 */

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "Status: frame-3 pending → processing" */
export function statusTransitionLine(label, oldStatus, newStatus) {
  return `🔁 Status: <code>${esc(label)}</code> ${esc(oldStatus)} → <strong>${esc(newStatus)}</strong>`;
}

/** "FAILED frame-3 — <error> (retry #2)" for a job.failed event. */
export function jobFailedLine({ key, error, retryCount, willRetry }) {
  const attempt = (Number(retryCount) || 0) + 1;
  return (
    `${willRetry ? '🔄' : '❌'} <span class="event-${willRetry ? 'retry' : 'failed'}">FAILED</span> ` +
    `<code>${esc(key || '?')}</code> — ${esc(error || 'unknown error')}` +
    (willRetry ? ` (retry #${attempt})` : ' (no more retries)')
  );
}
