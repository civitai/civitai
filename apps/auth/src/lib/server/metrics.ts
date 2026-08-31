// Prometheus metrics for the auth hub. This is the hub's FIRST metrics endpoint — before this, the
// Grafana dashboard was entirely LogQL-derived. The counters here let those panels move off logs.
//
// Cardinality discipline: labels are bounded, low-cardinality enums ONLY. NEVER put userId / email / IP
// (or any unbounded value) in a label — that would blow up the time-series count and the scrape payload.
//
// All counters are registered at module load with their full label sets pre-declared, so they export `0`
// before the first increment (no "metric appears only after the first event" gaps in dashboards).

import { Registry, collectDefaultMetrics, Counter } from 'prom-client';

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

/**
 * Signups refused because the email domain is blocklisted, by which half of the gate refused.
 * Without this the gate is unobservable: a refusal increments nothing else (`loginsTotal` is past
 * the OAuth throw, `emailLoginFailuresTotal` counts only server errors), so nobody could tell a gate
 * that fired ten thousand times from one that never fired, or measure the false-positive rate the
 * change was justified with.
 */
export const blockedEmailDomainSignupsTotal = new Counter({
  name: 'hub_blocked_email_domain_signups_total',
  help: 'Signups refused because the email domain is on the blocklist, labeled by login path.',
  labelNames: ['path'] as const,
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

// Every failure mode of the cross-domain hand-off (pending-authz.ts, ClickUp 868kxch09) is SILENT: it falls
// back to writing the hub session, so a broken deploy still logs people in. Read these together — `issued`
// should track `matched`; `fell_back` climbing, or `matched` lagging `issued`, means the bug is back.

/**
 * Outcome of a cross-domain login's attempt to withhold the hub session.
 *   issued     — record stored, hub session withheld (the fix working)
 *   fell_back  — record could not be stored (no redis / redis error); hub session written as before
 */
export const crossDomainHandoffTotal = new Counter({
  name: 'hub_cross_domain_handoff_total',
  help: 'Cross-domain login hand-off attempts, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [register],
});

/**
 * Outcome of consuming that record at /api/auth/oauth/authorize.
 *   matched          — record spent; the authorization uses the freshly authenticated identity
 *   domain_mismatch  — record belongs to a different spoke family; left alone, session used instead
 *   absent           — no usable record (expired, already spent, corrupt, or redis unavailable)
 * A `matched` count well below `issued` means records are being minted and never redeemed — the hop is
 * broken (cookie not arriving, or the domains disagree), and every one of those logins silently re-pointed
 * civitai.com.
 */
export const crossDomainHandoffConsumeTotal = new Counter({
  name: 'hub_cross_domain_handoff_consume_total',
  help: 'Cross-domain hand-off record consumption at /authorize, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [register],
});
