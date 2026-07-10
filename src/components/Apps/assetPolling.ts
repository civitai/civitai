/**
 * App Store Listings (W13) — P3a off-site asset-attach POLL decision logic
 * (PURE, no React, no timers). Extracted from `ExternalSubmitForm`'s asset step
 * so the backoff schedule + the keep-polling / terminal decision are unit-testable
 * WITHOUT mounting the component or faking timers.
 *
 * Context: an attach (setIcon / setCover / addScreenshot) requires a scan-complete
 * image. A freshly-persisted image is still scanning — so the attach now RESOLVES
 * with `{ status: 'pending' }` (a normal expected wait, NOT a 4xx) while the scan
 * is in-flight, and `{ status: 'attached' }` once it lands. The component
 * auto-re-runs the attach on the schedule below, transitioning to `attached` the
 * moment the scan lands, to `error` on a THROWN terminal failure (blocked /
 * not-found / bad-format → stop), or to `timeout` once the budget is exhausted
 * (keep the manual Retry).
 *
 * (Supersedes #3016's pending-CONFLICT: pending is no longer an error the poller
 * keys off a tRPC `code` — it is the mutation's own resolved `status`.)
 */

/** The classification of a single attach() outcome, independent of React state. */
export type AttachOutcome =
  /** The attach succeeded — the asset is scan-complete and attached. Terminal. */
  | { kind: 'attached' }
  /** The attach resolved `pending` because the scan isn't complete yet — keep polling. */
  | { kind: 'scanning' }
  /** The attach THREW a terminal failure (blocked / not-found / bad-format). Terminal. */
  | { kind: 'error'; message: string };

/** The resolved (success) shape of an attach mutation — the discriminant is `status`. */
export type AttachResult = { status: 'pending' | 'attached' };

/**
 * The input to {@link classifyAttachResult}: EITHER the RESOLVED mutation result
 * (`{ result }`) — whose `status` decides pending-vs-attached — OR a THROWN terminal
 * error (`{ error }`), carrying its human message for DISPLAY only. Pending is no
 * longer an error, so there is no tRPC `code` to inspect.
 */
export type AttachInput = { result: AttachResult } | { error: { message: string } };

/**
 * Backoff schedule (ms) between successive attach re-tries while an image is
 * scanning. Front-loaded (a scan usually lands within a few seconds) then eased
 * out; the FINAL entry repeats until the cumulative budget is spent. Chosen so
 * the total polling window is ~2–3 min — long enough for a real scan, bounded so
 * a stuck scan surfaces a timeout instead of polling forever.
 *
 * attempt 0 = the delay BEFORE the 1st re-try (the initial attach already ran),
 * attempt 1 = before the 2nd re-try, … Indices past the array reuse the last value.
 */
export const POLL_SCHEDULE_MS: readonly number[] = [
  2000, 3000, 3000, 5000, 5000, 8000, 8000, 10000, 10000, 12000, 12000, 15000,
];

/**
 * Total polling budget (ms). Once the CUMULATIVE delay of the re-tries reaches
 * this, `nextPollDelay` returns null (give up → timeout state). Sized to admit
 * the whole `POLL_SCHEDULE_MS` sequence plus a couple of trailing 15s repeats,
 * i.e. ~3 min of real-world scan wait.
 */
export const POLL_BUDGET_MS = 180000;

/**
 * The delay (ms) to wait before re-try number `attempt` (0-indexed), or `null`
 * when the cumulative budget is exhausted (→ stop polling, show a timeout). PURE:
 * the schedule + budget are the only inputs, so the whole backoff is testable
 * without timers.
 *
 * `attempt` must be ≥ 0. The cumulative wait BEFORE this attempt is summed from
 * the schedule (clamping out-of-range indices to the last entry); if adding this
 * attempt's delay would exceed `POLL_BUDGET_MS`, we give up.
 */
export function nextPollDelay(
  attempt: number,
  schedule: readonly number[] = POLL_SCHEDULE_MS,
  budgetMs: number = POLL_BUDGET_MS
): number | null {
  if (!Number.isFinite(attempt) || attempt < 0) return null;
  if (schedule.length === 0) return null;
  const delayAt = (i: number): number =>
    schedule[Math.min(i, schedule.length - 1)] ?? schedule[schedule.length - 1] ?? 0;
  let cumulative = 0;
  for (let i = 0; i < attempt; i++) cumulative += delayAt(i);
  const thisDelay = delayAt(attempt);
  if (cumulative + thisDelay > budgetMs) return null;
  return thisDelay;
}

/**
 * Classify an attach() outcome into an {@link AttachOutcome}. PURE.
 *
 * The retriable-vs-terminal decision is STRUCTURAL — it reads the mutation's own
 * resolved `status`, NEVER prose (rewording a server message can't change the
 * outcome). A RESOLVED result with `status: 'pending'` is retriable → `scanning`;
 * `status: 'attached'` is done → `attached`. A THROWN error is terminal → `error`,
 * carrying its human `message` for DISPLAY only. (No tRPC `code` inspection —
 * pending is a success result, not an error.)
 */
export function classifyAttachResult(input: AttachInput): AttachOutcome {
  if ('error' in input) return { kind: 'error', message: input.error.message };
  return input.result.status === 'pending' ? { kind: 'scanning' } : { kind: 'attached' };
}

/**
 * Whether to schedule ANOTHER poll given the latest outcome and the number of
 * re-tries already made. PURE. Keep polling only while the outcome is `scanning`
 * AND the schedule still has budget for the next attempt. Returns the delay to
 * use (so the caller doesn't re-derive it) or `null` to STOP (terminal outcome or
 * budget exhausted → the caller shows attached / error / timeout accordingly).
 */
export function shouldKeepPolling(
  outcome: AttachOutcome,
  attempt: number,
  schedule: readonly number[] = POLL_SCHEDULE_MS,
  budgetMs: number = POLL_BUDGET_MS
): { keep: true; delayMs: number } | { keep: false } {
  if (outcome.kind !== 'scanning') return { keep: false };
  const delayMs = nextPollDelay(attempt, schedule, budgetMs);
  if (delayMs === null) return { keep: false };
  return { keep: true, delayMs };
}
