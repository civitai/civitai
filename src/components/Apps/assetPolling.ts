/**
 * App Store Listings (W13) — P3a off-site asset-attach POLL decision logic
 * (PURE, no React, no timers). Extracted from `ExternalSubmitForm`'s asset step
 * so the backoff schedule + the keep-polling / terminal decision are unit-testable
 * WITHOUT mounting the component or faking timers.
 *
 * Context: an attach (setIcon / setCover / addScreenshot) requires a
 * scan-complete image. A freshly-persisted image is still scanning, so the attach
 * first rejects with "scan is not complete". Previously the asset then sat in
 * `processing` forever until the author clicked Retry — there was NO polling. The
 * component now auto-re-runs the attach on the schedule below, transitioning to
 * `attached` the moment the scan lands, to `error` on a NON-scan failure (blocked
 * / NSFW → stop), or to `timeout` once the budget is exhausted (keep the manual
 * Retry).
 */

/** The classification of a single attach() outcome, independent of React state. */
export type AttachOutcome =
  /** The attach succeeded — the asset is scan-complete and attached. Terminal. */
  | { kind: 'attached' }
  /** The attach rejected because the scan isn't complete yet — keep polling. */
  | { kind: 'scanning' }
  /** The attach rejected for a non-scan reason (blocked / NSFW / bad dims). Terminal. */
  | { kind: 'error'; message: string };

/** Matches the server's "scan is not complete" rejection (the only retriable one). */
export const SCAN_INCOMPLETE = /scan is not complete/i;

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
 * Classify an attach() result — either a resolved success or a caught error's
 * message — into an {@link AttachOutcome}. PURE. `errorMessage === null` means the
 * attach resolved (success). A "scan is not complete" message is retriable
 * (`scanning`); any other message is a terminal `error`.
 */
export function classifyAttachResult(errorMessage: string | null): AttachOutcome {
  if (errorMessage === null) return { kind: 'attached' };
  if (SCAN_INCOMPLETE.test(errorMessage)) return { kind: 'scanning' };
  return { kind: 'error', message: errorMessage };
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
