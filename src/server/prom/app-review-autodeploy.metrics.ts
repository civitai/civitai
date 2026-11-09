// Backstops of the automatic review flow: how many review previews and agent reviews started on
// their own, and how many were held back by each limit.
//
// One counter, `civitai_app_review_autodeploy_total{event}`, with a closed label set seeded at 0
// so "never fired" reads as a zero, not as no data. No slug, request or user label.
//
// Per-pod counter that resets on restart: read it across pods with a range function, e.g.
// `sum(increase(civitai_app_review_autodeploy_total{event="budget_refused"}[1d]))`.
//
// Same registry rules as the neighbouring modules: get-or-create against the DEFAULT registry.
import client, { type Counter, type Registry } from 'prom-client';

export const APP_REVIEW_AUTODEPLOY_METRIC = 'civitai_app_review_autodeploy_total';

export const APP_REVIEW_AUTODEPLOY_EVENTS = [
  // A submission's review preview was queued for an automatic build.
  'auto_started',
  // A queued preview's build was started by the drain.
  'queued_started',
  // The drain found queued previews but every build slot was taken.
  'build_cap_wait',
  // The submitter's daily automatic-build budget was spent; the preview waits for a moderator.
  'budget_refused',
  // The daily budget could not be read (Redis); treated as spent.
  'budget_unavailable',
  // A queued build could not be started (source resolve or trigger failed).
  'start_failed',
  'agent_review_auto_started',
  // The platform's daily agent-review budget was spent; agent review stays manual.
  'agent_review_budget_refused',
  'agent_review_start_failed',
] as const;
export type AppReviewAutodeployEvent = (typeof APP_REVIEW_AUTODEPLOY_EVENTS)[number];

const HELP =
  'Automatic App Block review flow events. event: auto_started (a submission was queued for a ' +
  'review preview), queued_started (a queued build started), build_cap_wait (queued builds ' +
  'waiting on the platform build cap), budget_refused / budget_unavailable (the submitter daily ' +
  'auto-build budget was spent / unreadable; the preview waits for a moderator), start_failed, ' +
  'agent_review_auto_started, agent_review_budget_refused (platform daily agent-review budget ' +
  'spent), agent_review_start_failed. Per-pod counter; read with range functions.';

function getOrCreateCounter(reg: Registry): Counter<string> {
  const existing = reg.getSingleMetric(APP_REVIEW_AUTODEPLOY_METRIC) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: APP_REVIEW_AUTODEPLOY_METRIC,
    help: HELP,
    labelNames: ['event'],
    registers: [reg],
  });
}

/** Get-or-create the counter and seed every event at 0. Idempotent; `/api/metrics` calls it once. */
export function ensureRegisterAppReviewAutodeployMetrics(reg: Registry = client.register): {
  appReviewAutodeployTotal: Counter<string>;
} {
  const appReviewAutodeployTotal = getOrCreateCounter(reg);
  for (const event of APP_REVIEW_AUTODEPLOY_EVENTS) appReviewAutodeployTotal.inc({ event }, 0);
  return { appReviewAutodeployTotal };
}

/** Count one event. Never throws; an event outside the closed set is dropped. */
export function recordAppReviewAutodeployEvent(event: AppReviewAutodeployEvent): void {
  try {
    if (!(APP_REVIEW_AUTODEPLOY_EVENTS as readonly string[]).includes(event)) return;
    getOrCreateCounter(client.register).inc({ event });
  } catch {
    // never throw from telemetry
  }
}
