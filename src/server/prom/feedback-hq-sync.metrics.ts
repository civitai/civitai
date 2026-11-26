// The feedback ↔ HQ status sync (`feedback-hq-sync` job): what each run did to feedback rows.
//
// One counter, `civitai_feedback_hq_sync_total{event}`, with a closed label set seeded at 0 so
// "never happened" reads as a zero, not as no data. No feedback, task or user label.
//
// Per-pod counter that resets on restart: read it across pods with a range function, e.g.
// `sum(increase(civitai_feedback_hq_sync_total{event="hq_read_failed"}[1d]))`.
//
// Same registry rules as the neighbouring modules: get-or-create against the DEFAULT registry.
import client, { type Counter, type Registry } from 'prom-client';

export const FEEDBACK_HQ_SYNC_METRIC = 'civitai_feedback_hq_sync_total';

export const FEEDBACK_HQ_SYNC_EVENTS = [
  // A row's status moved to reviewed / actioned / dismissed.
  'moved_reviewed',
  'moved_actioned',
  'moved_dismissed',
  // Only the HQ task link was recorded; the status stayed.
  'stamped',
  // The row was no longer at the status read a moment before; nothing was written.
  'conflict',
  // The row no longer exists.
  'gone',
  // A moderator reviewed the row and its task is a wontfix: the sync does not dismiss it.
  'human_set',
  // A moderator moved the row back to `new` (it carries the sync hold): the sync left it alone.
  'held',
  // A merged task was followed to the task it was merged into.
  'merge_followed',
  // The task's outcome could not be read as a status (hidden target, unknown done status, a merge
  // target that is itself merged); the row's status stayed.
  'unresolved',
  // An HQ read failed (the link list, or one task).
  'hq_read_failed',
  // HQ held more links than one run reads; the run worked the ones it read.
  'links_truncated',
  // The triage write itself failed (the moderator app did not answer); retried next run.
  'write_failed',
  // The link's area is not the row's (or HQ recorded none); the row was skipped.
  'area_mismatch',
  // A run stopped at its deadline or its task-read cap; the next run starts over.
  'stopped_early',
] as const;
export type FeedbackHqSyncEvent = (typeof FEEDBACK_HQ_SYNC_EVENTS)[number];

const HELP =
  'Feedback triage status sync from HQ tasks. event: moved_reviewed / moved_actioned / ' +
  'moved_dismissed (a row moved), stamped (only the HQ link recorded), conflict (the row moved ' +
  'meanwhile; not written), gone, human_set (a moderator reviewed it and the task is wontfix; not dismissed), held (moved back to new by a moderator; left alone), merge_followed, ' +
  'unresolved (the task outcome could not be read as a status), hq_read_failed, links_truncated, write_failed, area_mismatch, stopped_early. ' +
  'Per-pod counter; ' +
  'read with range functions.';

function getOrCreateCounter(reg: Registry): Counter<string> {
  const existing = reg.getSingleMetric(FEEDBACK_HQ_SYNC_METRIC) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: FEEDBACK_HQ_SYNC_METRIC,
    help: HELP,
    labelNames: ['event'],
    registers: [reg],
  });
}

/** Get-or-create the counter and seed every event at 0. Idempotent; `/api/metrics` calls it once. */
export function ensureRegisterFeedbackHqSyncMetrics(reg: Registry = client.register) {
  const counter = getOrCreateCounter(reg);
  for (const event of FEEDBACK_HQ_SYNC_EVENTS) counter.inc({ event }, 0);
  return counter;
}

/** Count `n` of one event. Never throws; an event outside the closed set is dropped. */
export function recordFeedbackHqSyncEvent(event: FeedbackHqSyncEvent, n = 1): void {
  try {
    if (!(FEEDBACK_HQ_SYNC_EVENTS as readonly string[]).includes(event) || n <= 0) return;
    getOrCreateCounter(client.register).inc({ event }, n);
  } catch {
    // never throw from telemetry
  }
}
