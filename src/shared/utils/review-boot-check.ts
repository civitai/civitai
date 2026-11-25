import { BLOCK_READY_TIMEOUT_MS } from '~/shared/constants/block-ready.constants';

/**
 * App Block review BOOT CHECK — the shared half (server and moderator UI).
 *
 * A review build is marked `preview-live` once its preview answers over HTTP. That proves the
 * files are served, not that the app starts: an app whose ES modules are served with a
 * non-JavaScript type answers 200 and never sends `BLOCK_READY`. The boot check loads the preview
 * the way a host does and records whether `BLOCK_READY` arrived within the host's own window
 * (`BLOCK_READY_TIMEOUT_MS`), on the preview's detail as `bootCheck`.
 *
 * The rollout flag decides what a result does (`REVIEW_BOOT_CHECK_FLAG`, a variant flag):
 *   - `off` (or absent): no check runs, nothing is recorded.
 *   - `shadow`: the result is recorded with `mode: 'shadow'` and changes nothing.
 *   - `enforce`: `failed` fails the preview and places the boot-check REVIEW HOLD on the app
 *     (`BOOT_CHECK_HOLD_LABEL`); a later `passed` clears it. `unavailable` (the checker could not
 *     run) leaves the preview live and Approve enabled, with a notice to the moderator.
 *
 * 🔴 What refuses Approve is the HOLD, through the ordinary review-hold check of the approve path:
 * it lives on the app, not on the preview, so a teardown or a rebuild does not remove it, and a
 * moderator can override it with a written reason (the escape hatch when the checker is wrong).
 * The summary predicates below only choose what the moderator is told; they read the RECORDED
 * mode, so a shadow result never shows as a failure.
 */

/** The Flipt variant flag: `shadow` | `enforce`; any other answer, a missing flag included, is off. */
export const REVIEW_BOOT_CHECK_FLAG = 'app-blocks-review-boot-check';

export type ReviewBootCheckMode = 'off' | 'shadow' | 'enforce';
/** The modes a recorded result can carry (an `off` check records nothing). */
export type ReviewBootCheckRecordedMode = Exclude<ReviewBootCheckMode, 'off'>;

export const REVIEW_BOOT_CHECK_RESULTS = ['passed', 'failed', 'unavailable'] as const;
export type ReviewBootCheckResult = (typeof REVIEW_BOOT_CHECK_RESULTS)[number];

/** What a boot check stores on the review preview's detail (`deploy_detail.bootCheck`). */
export type ReviewBootCheckRecord = {
  result: ReviewBootCheckResult;
  /** How long the check took, as the checker reported it; null when it did not answer. */
  ms: number | null;
  /** The host-protocol messages the app sent during the check (e.g. `BLOCK_HELLO`). */
  messagesSeen: string[];
  /** The first console error, else the first module served as something other than JavaScript. */
  firstError: string | null;
  checkedAt: string;
  mode: ReviewBootCheckRecordedMode;
};

/** The part of a record the queue, the review page and the approve gate read. */
export type ReviewBootCheckSummary = {
  result: ReviewBootCheckResult;
  mode: ReviewBootCheckRecordedMode;
};

function isResult(v: unknown): v is ReviewBootCheckResult {
  return typeof v === 'string' && (REVIEW_BOOT_CHECK_RESULTS as readonly string[]).includes(v);
}

/**
 * The boot check recorded on a publish request's review preview, or null when there is none.
 * Only a `preview-*` row carries a review preview detail; any other value of the column is a
 * production deploy's and is never read as one. A malformed record reads as none.
 */
export function reviewBootCheckSummary(
  deployState: string | null | undefined,
  detail: unknown
): ReviewBootCheckSummary | null {
  if (typeof deployState !== 'string' || !deployState.startsWith('preview-')) return null;
  if (!detail || typeof detail !== 'object') return null;
  const raw = (detail as { bootCheck?: unknown }).bootCheck;
  if (!raw || typeof raw !== 'object') return null;
  const { result, mode } = raw as { result?: unknown; mode?: unknown };
  if (!isResult(result)) return null;
  if (mode !== 'shadow' && mode !== 'enforce') return null;
  return { result, mode };
}

/**
 * True when an ENFORCED boot check found that the build never reached `BLOCK_READY`: the review
 * action bar shows why the app is held. NOT the approve gate (the boot-check hold is): it reads
 * the preview's detail, which a teardown or rebuild replaces.
 */
export function bootCheckFailed(summary: ReviewBootCheckSummary | null | undefined): boolean {
  return summary?.mode === 'enforce' && summary.result === 'failed';
}

/** An enforced boot check could not run. Approve stays enabled; the moderator is told. */
export function bootCheckUnavailable(summary: ReviewBootCheckSummary | null | undefined): boolean {
  return summary?.mode === 'enforce' && summary.result === 'unavailable';
}

const READY_WINDOW_SECONDS = Math.round(BLOCK_READY_TIMEOUT_MS / 1000);

/** The `detail.error` of a preview an enforced boot check failed: shown to moderators and authors. */
export function bootCheckFailureError(firstError: string | null): string {
  // A browser error usually ends in its own full stop; drop it so the sentence ends in one.
  const cause = firstError
    ? `First error: ${firstError.replace(/[.\s]+$/, '')}.`
    : 'No console error was reported: check that the app completes the SDK handshake when it loads.';
  return `Boot check: the app loaded but never sent BLOCK_READY within ${READY_WINDOW_SECONDS}s. ${cause} Fix and resubmit.`;
}

/**
 * What a moderator is told beside a failed enforced boot check. Approve is refused by the
 * boot-check hold this failure placed (shown in the holds panel), not by this text.
 */
export const BOOT_CHECK_APPROVE_REFUSAL =
  'The boot check found that this build never finishes loading (no BLOCK_READY), and placed a ' +
  'boot-check hold on the app. The hold stays until a build of this app passes the boot check; ' +
  'rebuilding or tearing down the preview does not remove it. To approve before that, override ' +
  'the hold with a written reason.';

/** The `placed_by_label` of the boot check's review hold (placed by the system user). */
export const BOOT_CHECK_HOLD_LABEL = 'Boot check';

/** The reason the boot-check hold carries: what the check saw, and what lifts it. */
export function bootCheckHoldReason(firstError: string | null): string {
  return (
    `The app loaded but never sent BLOCK_READY within ${READY_WINDOW_SECONDS}s` +
    (firstError ? ` (first error: ${firstError.replace(/[.\s]+$/, '')})` : '') +
    '. A build of this app that passes the boot check clears this hold.'
  );
}

/** The clear reason recorded when a passed boot check lifts the hold. */
export const BOOT_CHECK_HOLD_CLEAR_REASON = 'A later build of this app passed the boot check.';

/**
 * Under a CURRENT `enforce` flag: this pending request has no enforced `passed` check, so nobody
 * has confirmed its app finishes loading. Approve stays enabled (nothing is blocked
 * retroactively); the moderator is told.
 */
export function bootCheckNotVerified(
  currentMode: ReviewBootCheckMode,
  summary: ReviewBootCheckSummary | null | undefined
): boolean {
  if (currentMode !== 'enforce') return false;
  return !(summary?.mode === 'enforce' && summary.result === 'passed');
}

/** The moderator notice for a pending request `bootCheckNotVerified` holds for. */
export const BOOT_CHECK_NOT_RUN_NOTICE =
  'Boot check not run: this build has not passed the boot check, so nobody has confirmed the ' +
  'app finishes loading. Check that the preview starts before you approve.';

/** The moderator notice for a boot check that could not run. */
export const BOOT_CHECK_UNAVAILABLE_NOTICE =
  "Boot check couldn't run for this build, so nobody has confirmed the app finishes loading. " +
  'Check that the preview starts before you approve.';
