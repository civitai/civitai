import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import {
  resolveConsentBridgePrelude,
  type TrainingBridgeGateInput,
} from '~/components/AppBlocks/runTrainingGate';
import { CONFIRMED_STEP_DAILY_LIMIT_ERROR_CODE } from '~/shared/constants/block-scope.constants';

/**
 * The decision + copy layer for the `RUN_CONFIRMED_STEP` host bridge — ONE
 * pass-through step whose FIXED price exceeds the app's per-call budget, run only once
 * the viewer confirms that exact price. PURE and host-agnostic, like
 * `runTrainingGate.ts`, which it mirrors.
 *
 * ## What the bridge does
 *
 * The block has already estimated a pass-through body and holds the `stepQuote.quoteId`
 * the estimate returned. On `RUN_CONFIRMED_STEP { requestId, body }` (the body carries
 * that `quoteId`) the PAGE host:
 *   1. asks the server for the quote it is about to confirm
 *      (`blocks.previewQuoteGrant`) — price, `$type`, expiry, shortfall, and the
 *      viewer's own daily limit for the app — all server-resolved;
 *   2. if the job would exceed what remains of that daily limit, shows WHY and where
 *      to raise it, and replies `daily-limit-exceeded` — there is no confirm to click;
 *   3. otherwise shows the price in a host-chrome confirm;
 *   4. on confirm, records the viewer's confirmation (`blocks.consentQuoteGrant`,
 *      session-required) and THEN submits the body (`blocks.submitWorkflow`);
 *   5. replies `CONFIRMED_STEP_RESULT { requestId, snapshot }` or `{ requestId, error }`.
 *
 * 🔴 THE DIALOG IS THE CONSENT SURFACE, NOT THE CONTROL. The server refuses a confirmed
 * submit whose quote nobody confirmed, and only a signed-in session can confirm one. A
 * block that skips this bridge and calls the submit itself gets that refusal — and a
 * block that draws its own "confirm" in its iframe confirms nothing.
 *
 * 🔴 EVERY NUMBER THE DIALOG SHOWS COMES FROM THE SERVER'S PREVIEW. The block's own
 * `body` is forwarded to the submit untouched (the server checks it against the quote's
 * body hash) and is never rendered. The only block-influenced values on the consent
 * surface are `appName` (publisher-controlled, sanitized below) and the quoted `$type`
 * (the server's stored copy, shown as a code label).
 *
 * Only `PageBlockHost` registers a handler. The model slot has none and the shared
 * dispatcher NACKs `RUN_CONFIRMED_STEP` there with a `CONFIRMED_STEP_RESULT` error —
 * confirmed steps are page-only on the server too.
 */

/** The server-resolved consent payload. Mirrors `blocks.previewQuoteGrant` for an `sq_` quote. */
export type ConfirmedStepQuotePreview = {
  quoteId: string;
  total: number;
  stepType: string;
  expiresAt: string;
  /** Buzz the viewer is short by; `null` when the balance could not be read. */
  shortfall: number | null;
  /** The viewer's own daily limit for this app, or `null` when they set none. */
  dailyLimit: { limit: number; spentToday: number; remaining: number } | null;
  /** TRUE when the job exceeds what remains of `dailyLimit` today. */
  exceedsDailyLimit: boolean;
};

/**
 * The refusal codes the HOST itself emits on `CONFIRMED_STEP_RESULT`. Like
 * `RUN_TRAINING_HOST_ERRORS`, this is the set a block can RELY on, not the set it may
 * RECEIVE — server messages flow through the same `error` field.
 */
export const RUN_CONFIRMED_STEP_HOST_ERRORS = [
  /** Mod-review sandbox with run-for-real off. */
  'review-mode',
  /** The block has not finished loading. */
  'block is not ready',
  /** Anonymous viewer — there is no account to charge. */
  'sign in to run',
  /** The payload is not a pass-through `kind:'step'` body naming a quote. */
  'invalid confirmed step request',
  /** The host holds no block token yet. */
  'no block token',
  /** The viewer dismissed the confirm. Guaranteed to mean NO job was submitted. */
  'declined',
  /**
   * The job would exceed what remains of the viewer's own daily Buzz limit for this
   * app. NO job was submitted; the viewer was told and pointed at where to raise it.
   * Never overridable by a confirm.
   */
  CONFIRMED_STEP_DAILY_LIMIT_ERROR_CODE,
  /**
   * The submit was SENT but its outcome is unknown. The job may be running and charged
   * — check the viewer's generations before offering a retry.
   */
  'submission-unconfirmed',
] as const satisfies readonly string[];

export type RunConfirmedStepHostError = (typeof RUN_CONFIRMED_STEP_HOST_ERRORS)[number];

/** The shape of a confirmed-STEP quote id (mirrors the server's `BLOCK_STEP_QUOTE_ID_REGEX`). */
const CONFIRMED_STEP_QUOTE_ID_SHAPE = /^sq_[a-f0-9]{32}$/;

export type RunConfirmedStepGateDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: RunConfirmedStepHostError }
  | {
      kind: 'proceed';
      request: { requestId: string; quoteId: string; body: Record<string, unknown> };
    };

/**
 * Validate a raw `RUN_CONFIRMED_STEP` payload from an untrusted iframe and decide drop /
 * refuse / proceed. SHAPE ONLY — the server re-validates the body against the wire
 * schema and the stored quote. Dropping is safe only before a `requestId` is known.
 */
export function resolveRunConfirmedStepRequest(
  input: TrainingBridgeGateInput
): RunConfirmedStepGateDecision {
  const prelude = resolveConsentBridgePrelude(input, 'sign in to run');
  if (prelude.kind !== 'ok') return prelude;
  const { requestId, obj } = prelude;

  const body = obj.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'refuse', requestId, error: 'invalid confirmed step request' };
  }
  const b = body as Record<string, unknown>;
  // The quote must be a STEP quote by shape: this dialog must never be asked to confirm
  // another kind's quote. The server binds the kind too (`blocks.previewQuoteGrant`).
  if (
    b.kind !== 'step' ||
    typeof b.$type !== 'string' ||
    typeof b.quoteId !== 'string' ||
    !CONFIRMED_STEP_QUOTE_ID_SHAPE.test(b.quoteId)
  ) {
    return { kind: 'refuse', requestId, error: 'invalid confirmed step request' };
  }
  return { kind: 'proceed', request: { requestId, quoteId: b.quoteId, body: b } };
}

const buzz = (n: number) => n.toLocaleString('en-US');

/**
 * The notice the HOST shows when a confirmed job's outcome is unknown. A confirmed step
 * is its own run each time it is confirmed, so trying again starts — and charges — a
 * second job if the first one did start. The block is told the same thing by code
 * (`submission-unconfirmed`), but the viewer is the one who would confirm again, so
 * the host says it in its own chrome.
 */
export const CONFIRMED_STEP_UNCONFIRMED_NOTICE = {
  title: 'We could not confirm this job',
  body:
    'The job may already be running, and you may have been charged for it. Check your ' +
    'generations before trying again — confirming again starts a new job.',
} as const;

export type ConfirmedStepConsentCopy = {
  title: string;
  intro: string;
  /** The price, in plain words — the line the viewer is agreeing to. */
  priceLine: string;
  /** The viewer's own daily limit for the app, when they set one. */
  dailyLimitLine: string | null;
  /** Present only when the viewer's balance is known to be short. */
  shortfallLine: string | null;
  confirmLabel: string;
};

/**
 * The copy for the confirmed-step consent confirm. Every number is from `preview`;
 * `appName` is sanitized with the same anti-spoof pass the training confirm uses.
 */
export function buildConfirmedStepConsentCopy({
  appName,
  preview,
}: {
  appName?: string | null;
  preview: ConfirmedStepQuotePreview;
}): ConfirmedStepConsentCopy {
  const who = sanitizeAppChromeName(appName) ?? 'This app';
  return {
    title: 'Run this job?',
    intro: `${who} wants to run one job that costs more than it can spend without asking you.`,
    priceLine: `This job costs ${buzz(preview.total)} Buzz, charged when it starts.`,
    dailyLimitLine: preview.dailyLimit
      ? `Your daily limit for this app is ${buzz(preview.dailyLimit.limit)} Buzz ` +
        `(${buzz(preview.dailyLimit.remaining)} left today).`
      : null,
    shortfallLine:
      preview.shortfall != null && preview.shortfall > 0
        ? `You need ${buzz(preview.shortfall)} more Buzz to run this job.`
        : null,
    confirmLabel: `Run for ${buzz(preview.total)} Buzz`,
  };
}

export type ConfirmedStepDailyLimitCopy = { title: string; body: string; linkLabel: string };

/**
 * The copy for the daily-limit REFUSAL — shown instead of a confirm, because the
 * confirm cannot override the viewer's own limit. Names the limit and what is left,
 * and points at where the viewer can raise it. `dailyLimit` is `null` only when the
 * SUBMIT refused a job the preview passed (the day's spend moved in between).
 */
export function buildConfirmedStepDailyLimitCopy({
  appName,
  total,
  dailyLimit,
}: {
  appName?: string | null;
  total: number;
  dailyLimit: ConfirmedStepQuotePreview['dailyLimit'];
}): ConfirmedStepDailyLimitCopy {
  const who = sanitizeAppChromeName(appName) ?? 'this app';
  const limitClause = dailyLimit
    ? `your daily limit of ${buzz(dailyLimit.limit)} Buzz for ${who} ` +
      `(${buzz(dailyLimit.remaining)} left today)`
    : `what remains of your daily limit for ${who}`;
  return {
    title: 'This job exceeds your daily limit',
    body:
      `This job costs ${buzz(total)} Buzz, which exceeds ${limitClause}. ` +
      `Nothing was charged. You can raise or remove the limit in your app settings.`,
    linkLabel: 'Change your daily limit',
  };
}

export type ConfirmedStepSubmitReply = { snapshot: unknown } | { error: string };

/**
 * The `CONFIRMED_STEP_RESULT` payload for a submit that RETURNED. An unconfirmed
 * outcome and the daily-limit refusal are told as their codes; any other returned
 * snapshot (a cap reached, a failed run) is forwarded as the block's snapshot.
 */
export function confirmedStepReplyFromResult(result: {
  snapshot?: unknown;
  submissionUnconfirmed?: unknown;
}): ConfirmedStepSubmitReply {
  if (result.submissionUnconfirmed === true) return { error: 'submission-unconfirmed' };
  if (isDailyLimitRefusal(result.snapshot)) return { error: CONFIRMED_STEP_DAILY_LIMIT_ERROR_CODE };
  return { snapshot: result.snapshot };
}

/** TRUE when a submit's snapshot is the server's daily-limit refusal. */
export function isDailyLimitRefusal(snapshot: unknown): boolean {
  return (
    !!snapshot &&
    typeof snapshot === 'object' &&
    (snapshot as { errorCode?: unknown }).errorCode === CONFIRMED_STEP_DAILY_LIMIT_ERROR_CODE
  );
}
