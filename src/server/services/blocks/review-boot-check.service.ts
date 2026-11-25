import { clampReviewSandbox, intersectSandbox } from '~/components/AppBlocks/sandbox';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { recordReviewBootCheck } from '~/server/prom/app-block-boot-check.metrics';
import { signReviewAccessToken } from '~/server/services/blocks/review-session';
import { BLOCK_READY_TIMEOUT_MS } from '~/shared/constants/block-ready.constants';
import {
  bootCheckFailureError,
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
 * Anything else (a non-200, an unreadable body, a network error, the 30 s client cap, no URL
 * configured) is `unavailable`: FAIL-OPEN, so a checker outage never blocks a submission.
 */

/** The client-side cap on one checker call. */
export const BOOT_CHECK_CLIENT_TIMEOUT_MS = 30_000;
/** The pause before the single retry of an `unavailable` attempt. */
export const BOOT_CHECK_RETRY_DELAY_MS = 2_000;
/** Longest `firstError` stored on the detail (it is shown to moderators and the author). */
const FIRST_ERROR_MAX_CHARS = 300;

/**
 * The user the check's entry token is bound to: the system actor, as for the HTTP probe, so the
 * check is never attributed to a moderator.
 */
const BOOT_CHECK_USER_ID = constants.system.user.id;

/** The rollout mode. Any answer other than `shadow` / `enforce`, a read error included, is off. */
export async function readReviewBootCheckMode(): Promise<ReviewBootCheckMode> {
  try {
    const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.APP_BLOCKS_REVIEW_BOOT_CHECK);
    return variant === 'shadow' || variant === 'enforce' ? variant : 'off';
  } catch {
    return 'off';
  }
}

/** One attempt's outcome, before it is reduced to the stored record. */
export type BootCheckAttempt = {
  result: ReviewBootCheckResult;
  ms: number | null;
  messagesSeen: string[];
  firstError: string | null;
  /** Why an attempt is `unavailable` (logged, never stored). */
  reason?: string;
};

function unavailable(reason: string): BootCheckAttempt {
  return { result: 'unavailable', ms: null, messagesSeen: [], firstError: null, reason };
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

/** A module the static server sent as something other than JavaScript, as one line. */
function nonJsModuleLine(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  const { url, contentType } = entry as { url?: unknown; contentType?: unknown };
  if (typeof url !== 'string') return null;
  return `${url} was served as ${
    typeof contentType === 'string' && contentType ? contentType : 'an unknown type'
  }, not JavaScript`;
}

/** The first thing an author can act on: a console error, else the first non-JavaScript module. */
export function firstBootError(body: {
  consoleErrors?: unknown;
  nonJsModuleResponses?: unknown;
}): string | null {
  const consoleError = stringList(body.consoleErrors).find((s) => s.trim().length > 0);
  if (consoleError) return sanitizeBootError(consoleError);
  if (Array.isArray(body.nonJsModuleResponses)) {
    for (const entry of body.nonJsModuleResponses) {
      const line = nonJsModuleLine(entry);
      if (line) return sanitizeBootError(line);
    }
  }
  return null;
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
  const signalFactory = deps.signalFactory ?? ((ms: number) => AbortSignal.timeout(ms));
  let res: Response;
  try {
    res = await doFetch(`${deps.baseUrl.replace(/\/$/, '')}/v1/boot-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: signalFactory(BOOT_CHECK_CLIENT_TIMEOUT_MS),
    });
  } catch (err) {
    return unavailable(`checker request failed: ${err instanceof Error ? err.name : 'error'}`);
  }
  if (res.status !== 200) return unavailable(`checker answered ${res.status}`);
  let body: Record<string, unknown>;
  try {
    const parsed = (await res.json()) as unknown;
    if (!parsed || typeof parsed !== 'object') return unavailable('checker body is not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return unavailable('checker body is not JSON');
  }
  if (body.result !== 'passed' && body.result !== 'failed') {
    return unavailable('checker body has no result');
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
    return unavailable('checker not configured');
  }
  if (!input.host || !input.url) return unavailable('the preview has no host or url');
  const host = input.host;
  const previewUrl = input.url;
  const target = await (deps.loadTarget ?? loadReviewTarget)(input.publishRequestId);
  const blockId = input.slug ?? target.slug;
  if (!blockId) return unavailable('no slug for the preview');
  const mintToken =
    deps.mintToken ??
    ((h: string) => signReviewAccessToken({ modUserId: BOOT_CHECK_USER_ID, host: h }));
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
  // A clean `failed` is a verdict about the app and is never retried.
  if (first.result !== 'unavailable') return first;
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
    attempt = unavailable(`check crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (attempt.result === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn(
      `[review-boot-check] unavailable for ${input.publishRequestId} (${mode}): ${attempt.reason}`
    );
  }
  recordReviewBootCheck(mode, attempt.result);
  return decideBootCheckSettle(mode, attempt, (deps.now ?? (() => new Date()))());
}
