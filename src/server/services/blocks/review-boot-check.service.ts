import { clampReviewSandbox, intersectSandbox } from '~/components/AppBlocks/sandbox';
import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { recordReviewBootCheck } from '~/server/prom/app-block-boot-check.metrics';
import { SHARED_REVIEW_PROBE_MOD_USER_ID } from '~/server/services/blocks/apps-pipeline.service';
import { signReviewAccessToken } from '~/server/services/blocks/review-session';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { BLOCK_READY_TIMEOUT_MS } from '~/shared/constants/block-ready.constants';
import {
  BOOT_CHECK_HOLD_CLEAR_REASON,
  bootCheckFailureError,
  bootCheckHoldReason,
  type ReviewBootCheckMode,
  type ReviewBootCheckRecord,
  type ReviewBootCheckRecordedMode,
  type ReviewBootCheckResult,
} from '~/shared/utils/review-boot-check';

/**
 * App Block review BOOT CHECK — the server half. See `~/shared/utils/review-boot-check` for what
 * the check is for and what each rollout mode does.
 *
 * The review-build watcher calls `evaluateReviewBootCheck` after the preview's HTTP probe passed
 * and before it writes `preview-live`. The row stays `preview-deploying` while the check runs.
 *
 * The checker is a separate service (`APP_BLOCK_BOOT_CHECK_URL`). It loads the preview URL in a
 * browser the way a host does, with the same block id, instance id and sandbox, and reports
 * whether the app sent `BLOCK_READY` within the host's window. Its contract:
 *
 *   POST <base>/v1/boot-check  { url, blockId, blockInstanceId, sandbox, timeoutMs }
 *   200 { result: 'passed' | 'failed', ms, messagesSeen[], consoleErrors[],
 *         failedRequests[{ url, status, contentType }], nonJsModuleResponses }
 *
 * `nonJsModuleResponses` is a COUNT (scripts the browser refused for a non-JavaScript type).
 *
 * Anything else (a non-200, an unreadable body, a network error, the 35 s client cap, no URL
 * configured) is `unavailable`: FAIL-OPEN, so a checker outage never blocks a submission. A 4xx
 * means this client and the checker disagree about the contract: still `unavailable`, but logged
 * at error level and counted under `reason="contract"`.
 *
 * Under `enforce`, a `failed` check also places the boot-check REVIEW HOLD on the app and a
 * `passed` one clears it (`syncBootCheckHold`). The hold, not the preview's detail, is what
 * refuses Approve, so tearing the preview down or rebuilding it cannot get around it.
 */

/**
 * The client-side cap on one checker call. Above the checker's own 30 s hard cap, so its 503 (and
 * the reason in it) arrives before this client gives up.
 */
export const BOOT_CHECK_CLIENT_TIMEOUT_MS = 35_000;
/** The pause before the single retry of an `unavailable` attempt. */
export const BOOT_CHECK_RETRY_DELAY_MS = 2_000;
/** Longest `firstError` stored on the detail (it is shown to moderators and the author). */
const FIRST_ERROR_MAX_CHARS = 300;

/** The rollout mode. Any answer other than `shadow` / `enforce`, a read error included, is off. */
export async function readReviewBootCheckMode(): Promise<ReviewBootCheckMode> {
  try {
    const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.APP_BLOCKS_REVIEW_BOOT_CHECK);
    return variant === 'shadow' || variant === 'enforce' ? variant : 'off';
  } catch {
    return 'off';
  }
}

/** Why a check is `unavailable`: the metric's `reason` label (`none` for passed / failed). */
export type BootCheckUnavailableReason =
  | 'unconfigured'
  | 'network'
  | 'server'
  | 'contract'
  | 'body'
  | 'no-target'
  | 'crash';

/** One attempt's outcome, before it is reduced to the stored record. */
export type BootCheckAttempt = {
  result: ReviewBootCheckResult;
  ms: number | null;
  messagesSeen: string[];
  firstError: string | null;
  /** Why an attempt is `unavailable` (logged, never stored). */
  reason?: string;
  /** The closed reason label for an `unavailable` attempt. */
  unavailableReason?: BootCheckUnavailableReason;
};

function unavailable(label: BootCheckUnavailableReason, reason: string): BootCheckAttempt {
  return {
    result: 'unavailable',
    ms: null,
    messagesSeen: [],
    firstError: null,
    reason,
    unavailableReason: label,
  };
}

function stringList(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string').slice(0, max);
}

/**
 * Make a checker-reported message safe to store and show: the entry token is a credential
 * (`mr=` in the preview URL, which a browser error can quote), and the text is the app's own
 * output, so it is reduced to one bounded line.
 */
export function sanitizeBootError(raw: string): string {
  const oneLine = raw
    .replace(/([?&])mr=[^&#\s"')]*/g, '$1mr=[redacted]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > FIRST_ERROR_MAX_CHARS
    ? `${oneLine.slice(0, FIRST_ERROR_MAX_CHARS - 1)}…`
    : oneLine;
}

/**
 * The first thing an author can act on: a console error, else how many scripts were served with
 * a non-JavaScript type (the checker reports that as a count, `nonJsModuleResponses`).
 */
export function firstBootError(body: {
  consoleErrors?: unknown;
  nonJsModuleResponses?: unknown;
}): string | null {
  const consoleError = stringList(body.consoleErrors).find((s) => s.trim().length > 0);
  if (consoleError) return sanitizeBootError(consoleError);
  const n = body.nonJsModuleResponses;
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
    return n === 1
      ? '1 script was served as non-JavaScript'
      : `${n} scripts were served as non-JavaScript`;
  }
  return null;
}

/** The checker's own reason on a non-200, for the log line (never stored). */
async function checkerReason(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 500);
    try {
      const body = JSON.parse(text) as { reason?: unknown; error?: unknown };
      const r = body.reason ?? body.error;
      if (typeof r === 'string') return sanitizeBootError(r);
    } catch {
      /* not JSON: use the text */
    }
    return sanitizeBootError(text);
  } catch {
    return '';
  }
}

export type BootCheckRequest = {
  url: string;
  blockId: string;
  blockInstanceId: string;
  sandbox: string;
  timeoutMs: number;
};

/** One call to the checker. Never throws: every failure is `unavailable`. */
export async function callBootChecker(
  request: BootCheckRequest,
  deps: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    signalFactory?: (ms: number) => AbortSignal | undefined;
  }
): Promise<BootCheckAttempt> {
  const doFetch = deps.fetchImpl ?? fetch;
  const signalFactory = deps.signalFactory ?? ((ms: number) => fetchTimeoutSignal(ms));
  let res: Response;
  try {
    res = await doFetch(`${deps.baseUrl.replace(/\/$/, '')}/v1/boot-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: signalFactory(BOOT_CHECK_CLIENT_TIMEOUT_MS),
    });
  } catch (err) {
    return unavailable(
      'network',
      `checker request failed: ${err instanceof Error ? err.name : 'error'}`
    );
  }
  if (res.status >= 400 && res.status < 500) {
    // A 4xx is this client's request the checker refused: a contract mismatch, not an outage.
    const why = await checkerReason(res);
    // eslint-disable-next-line no-console
    console.error(`[review-boot-check] checker refused the request (${res.status}): ${why}`);
    return unavailable('contract', `checker answered ${res.status}: ${why}`);
  }
  if (res.status !== 200) {
    return unavailable('server', `checker answered ${res.status}: ${await checkerReason(res)}`);
  }
  let body: Record<string, unknown>;
  try {
    const parsed = (await res.json()) as unknown;
    if (!parsed || typeof parsed !== 'object')
      return unavailable('body', 'checker body is not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return unavailable('body', 'checker body is not JSON');
  }
  if (body.result !== 'passed' && body.result !== 'failed') {
    return unavailable('body', 'checker body has no result');
  }
  return {
    result: body.result,
    ms: typeof body.ms === 'number' && Number.isFinite(body.ms) ? Math.round(body.ms) : null,
    messagesSeen: stringList(body.messagesSeen),
    firstError: body.result === 'failed' ? firstBootError(body) : null,
  };
}

let warnedUnconfigured = false;
/** Test seam: forget that the missing-URL warning was logged. */
export function resetBootCheckWarningsForTests(): void {
  warnedUnconfigured = false;
}

/** What the review host is given for this request: its block id and the manifest's sandbox. */
async function loadReviewTarget(
  publishRequestId: string
): Promise<{ slug: string | null; sandbox: string | null }> {
  try {
    const { dbRead } = await import('~/server/db/client');
    const row = await dbRead.appBlockPublishRequest.findUnique({
      where: { id: publishRequestId },
      select: { slug: true, manifest: true },
    });
    const iframe = (row?.manifest as { iframe?: { sandbox?: unknown } | null } | null)?.iframe;
    return {
      slug: typeof row?.slug === 'string' ? row.slug : null,
      sandbox: iframe && typeof iframe.sandbox === 'string' ? iframe.sandbox : null,
    };
  } catch {
    return { slug: null, sandbox: null };
  }
}

/**
 * The sandbox the review host applies, from the manifest's declared one: the review clamp, then
 * the `unverified` intersection (`ReviewBlockPreviewHost` → `PageBlockHost`), so the check runs
 * the app under exactly the iframe the moderator's preview uses.
 */
export function reviewHostSandbox(manifestSandbox: string | null | undefined): string {
  return intersectSandbox(clampReviewSandbox(manifestSandbox ?? 'allow-scripts'), 'unverified');
}

export type BootCheckDeps = {
  mode?: ReviewBootCheckMode;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
  signalFactory?: (ms: number) => AbortSignal | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  mintToken?: (host: string) => string;
  loadTarget?: typeof loadReviewTarget;
};

/** Run the check: a fresh entry token per attempt, and one retry when an attempt is unavailable. */
export async function runReviewBootCheck(
  input: { publishRequestId: string; slug?: string; host?: string; url?: string },
  deps: BootCheckDeps = {}
): Promise<BootCheckAttempt> {
  const baseUrl = deps.baseUrl !== undefined ? deps.baseUrl : env.APP_BLOCK_BOOT_CHECK_URL ?? null;
  if (!baseUrl) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[review-boot-check] APP_BLOCK_BOOT_CHECK_URL is not set: every boot check reads unavailable'
      );
    }
    return unavailable('unconfigured', 'checker not configured');
  }
  if (!input.host || !input.url) return unavailable('no-target', 'the preview has no host or url');
  const host = input.host;
  const previewUrl = input.url;
  const target = await (deps.loadTarget ?? loadReviewTarget)(input.publishRequestId);
  const blockId = input.slug ?? target.slug;
  if (!blockId) return unavailable('no-target', 'no slug for the preview');
  const mintToken =
    deps.mintToken ??
    // The HTTP probe's own entry-token user (the system actor), so the check is never
    // attributed to a moderator.
    ((h: string) => signReviewAccessToken({ modUserId: SHARED_REVIEW_PROBE_MOD_USER_ID, host: h }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const attempt = async () => {
    // Minted per attempt: the token lives 120 s and is bound to this one host.
    const sep = previewUrl.includes('?') ? '&' : '?';
    const url = `${previewUrl}${sep}mr=${encodeURIComponent(mintToken(host))}`;
    return callBootChecker(
      {
        url,
        blockId,
        // The same synthetic instance id the review host mounts the block with (mintReviewBlockToken).
        blockInstanceId: `page_${input.publishRequestId}`,
        sandbox: reviewHostSandbox(target.sandbox),
        timeoutMs: BLOCK_READY_TIMEOUT_MS,
      },
      { baseUrl, fetchImpl: deps.fetchImpl, signalFactory: deps.signalFactory }
    );
  };

  const first = await attempt();
  // A clean `failed` is a verdict about the app and is never retried; nor is a contract refusal,
  // which the same request would get again.
  if (first.result !== 'unavailable' || first.unavailableReason === 'contract') return first;
  await sleep(BOOT_CHECK_RETRY_DELAY_MS);
  return attempt();
}

/** What the watcher writes once the check settled. */
export type BootCheckDecision = {
  /** Write `preview-live` (true) or `preview-failed` (false). */
  live: boolean;
  bootCheck: ReviewBootCheckRecord;
  /** The `detail.error` for a failed preview. */
  error?: string;
};

/**
 * 🔴 THE shadow/enforce switch, pure. Only an ENFORCED `failed` fails the preview; shadow always
 * goes live, and `unavailable` goes live in both modes (fail-open).
 */
export function decideBootCheckSettle(
  mode: ReviewBootCheckRecordedMode,
  attempt: BootCheckAttempt,
  checkedAt: Date
): BootCheckDecision {
  const bootCheck: ReviewBootCheckRecord = {
    result: attempt.result,
    ms: attempt.ms,
    messagesSeen: attempt.messagesSeen,
    firstError: attempt.firstError,
    checkedAt: checkedAt.toISOString(),
    mode,
  };
  if (mode === 'enforce' && attempt.result === 'failed') {
    return { live: false, bootCheck, error: bootCheckFailureError(attempt.firstError) };
  }
  return { live: true, bootCheck };
}

/**
 * The watcher's entry point. `null` when the flag is off: no check runs and the caller writes
 * exactly what it wrote before the check existed. Never throws (a crash reads as unavailable).
 */
export async function evaluateReviewBootCheck(
  input: { publishRequestId: string; slug?: string; host?: string; url?: string },
  deps: BootCheckDeps = {}
): Promise<BootCheckDecision | null> {
  const mode = deps.mode ?? (await readReviewBootCheckMode());
  if (mode === 'off') return null;
  let attempt: BootCheckAttempt;
  try {
    attempt = await runReviewBootCheck(input, deps);
  } catch (err) {
    attempt = unavailable(
      'crash',
      `check crashed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (attempt.result === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn(
      `[review-boot-check] unavailable for ${input.publishRequestId} (${mode}): ${attempt.reason}`
    );
  }
  recordReviewBootCheck(
    mode,
    attempt.result,
    attempt.result === 'unavailable' ? attempt.unavailableReason ?? 'crash' : 'none'
  );
  return decideBootCheckSettle(mode, attempt, (deps.now ?? (() => new Date()))());
}

/**
 * Keep the app's boot-check REVIEW HOLD in step with an ENFORCED result: a `failed` check places
 * it (once: a second failure does not stack another), a `passed` one clears it. Shadow and
 * `unavailable` never touch it. Never throws: a hold write that fails is logged at error level
 * (the recorded failure on the preview detail still refuses Approve, see
 * `checkReviewGatesBeforeApprove`).
 *
 * 🔴 ONLY FOR THE BUILD THAT OWNS THE ACTIVE PREVIEW. The caller calls it only after its guarded
 * state write matched the row, and the hold write re-checks that ownership in its own transaction
 * (row locked: still pending, still a preview, still this build's sha), so a superseded watcher,
 * an older sha or a withdrawn earlier request, can neither clear the hold a newer failed build
 * placed nor place one over a newer pass.
 */
export async function syncBootCheckHold(
  publishRequestId: string,
  decision: BootCheckDecision,
  owner: { expectedSha: string }
): Promise<'placed' | 'exists' | 'cleared' | 'stale' | 'none'> {
  const { bootCheck } = decision;
  if (bootCheck.mode !== 'enforce') return 'none';
  if (bootCheck.result !== 'failed' && bootCheck.result !== 'passed') return 'none';
  try {
    const [{ dbWrite }, holds] = await Promise.all([
      import('~/server/db/client'),
      import('~/server/services/blocks/publish-request-holds.service'),
    ]);
    return await dbWrite.$transaction(async (tx) => {
      // The sha is the callback-validated 40-hex build sha: a safe LIKE literal.
      const owned = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM app_block_publish_requests
        WHERE id = ${publishRequestId} AND status = 'pending'
          AND deploy_state LIKE 'preview-%'
          AND deploy_detail LIKE ${`%"sha":"${owner.expectedSha}"%`}
        FOR UPDATE`;
      if (owned.length === 0) return 'stale' as const;
      if (bootCheck.result === 'failed') {
        return holds.placeBootCheckHold(tx, {
          publishRequestId,
          reason: bootCheckHoldReason(bootCheck.firstError),
        });
      }
      const cleared = await holds.clearBootCheckHolds(tx, {
        publishRequestId,
        reason: BOOT_CHECK_HOLD_CLEAR_REASON,
      });
      return cleared > 0 ? ('cleared' as const) : ('none' as const);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[review-boot-check] could not ${
        bootCheck.result === 'failed' ? 'place' : 'clear'
      } the boot-check hold for ${publishRequestId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return 'none';
  }
}
