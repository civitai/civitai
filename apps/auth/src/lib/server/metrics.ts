// Prometheus metrics for the auth hub. This is the hub's FIRST metrics endpoint — before this, the
// Grafana dashboard was entirely LogQL-derived. The counters here let those panels move off logs.
//
// Cardinality discipline: labels are bounded, low-cardinality enums ONLY. NEVER put userId / email / IP
// (or any unbounded value) in a label — that would blow up the time-series count and the scrape payload.
//
// All counters are registered at module load with their full label sets pre-declared, so they export `0`
// before the first increment (no "metric appears only after the first event" gaps in dashboards).

import {
  Registry,
  collectDefaultMetrics,
  Counter,
} from 'prom-client';

// Single default registry for the whole process. `register.metrics()` (in the /metrics route) serializes
// everything registered here.
export const register = new Registry();

// Node process / heap / event-loop / GC metrics (process_*, nodejs_*). Cheap, scraped on demand.
collectDefaultMetrics({ register });

/** Successful logins, by login provider (oauth provider id, or 'email' for the magic-link flow). */
export const loginsTotal = new Counter({
  name: 'hub_logins_total',
  help: 'Successful hub logins (standard login/signup path), labeled by provider.',
  labelNames: ['provider'] as const,
  registers: [register],
});

/** OAuth audit events, by event type (the audit-log `type` with dots→underscores, e.g. token_issued). */
export const oauthEventsTotal = new Counter({
  name: 'hub_oauth_events_total',
  help: 'OAuth audit events emitted by the hub, labeled by event type.',
  labelNames: ['type'] as const,
  registers: [register],
});

/** Email magic-link send failures (token creation / email-send threw and was caught). */
export const emailLoginFailuresTotal = new Counter({
  name: 'hub_email_login_failures_total',
  help: 'Email magic-link login failures (send/token error caught in the login action).',
  registers: [register],
});

/** Turnstile captcha verification outcomes, by result. Not counted when captcha is disabled. */
export const captchaVerificationsTotal = new Counter({
  name: 'hub_captcha_verifications_total',
  help: 'Turnstile captcha verifications by result (success / reject reason).',
  labelNames: ['result'] as const,
  registers: [register],
});

/** Unhandled errors surfaced to the SvelteKit handleError hook. */
export const unhandledErrorsTotal = new Counter({
  name: 'hub_unhandled_errors_total',
  help: 'Unhandled server errors caught by the SvelteKit handleError hook.',
  registers: [register],
});
