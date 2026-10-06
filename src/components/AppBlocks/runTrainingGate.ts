import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';

/**
 * The decision + copy layer for the `RUN_TRAINING` host bridge (App Blocks
 * `kind:'training'`). PURE and host-agnostic, like `createPostFromAppGate.ts`,
 * whose exactly-once / consent-latch settlement (`createPostSettlement`) the
 * handler reuses rather than re-deriving.
 *
 * ## What the bridge does
 *
 * The block has already estimated a training body and holds a `quoteId`. On
 * `RUN_TRAINING { requestId, body }` the PAGE host:
 *   1. asks the server for the quote it is about to confirm
 *      (`blocks.previewTrainingQuote`) — price, base model, epochs/steps, image
 *      count, thumbnails, expiry, shortfall — all server-resolved;
 *   2. shows that in a host-chrome confirm;
 *   3. on confirm, records the viewer's confirmation (`blocks.consentTrainingQuote`,
 *      session-required) and THEN submits the body (`blocks.submitWorkflow`);
 *   4. replies `TRAINING_RESULT { requestId, snapshot }` or `{ requestId, error }`.
 *
 * 🔴 THE DIALOG IS THE CONSENT SURFACE, NOT THE CONTROL. The server refuses a
 * training submit whose quote nobody confirmed, and only a signed-in session can
 * confirm one. A block that skips this bridge and calls the submit itself gets
 * that refusal.
 *
 * 🔴 EVERY NUMBER THE DIALOG SHOWS COMES FROM THE SERVER'S PREVIEW. The block's
 * own `body` is forwarded to the submit untouched (the server checks it against
 * the quote's body hash) and is never rendered. The only block-influenced value on
 * the consent surface is `appName` (publisher-controlled), sanitized below.
 *
 * Only `PageBlockHost` registers a handler. The model slot has no handler and the
 * shared dispatcher NACKs `RUN_TRAINING` there with a `TRAINING_RESULT` error —
 * training is page-only on the server too.
 */

/** The server-resolved consent payload. Mirrors `blocks.previewTrainingQuote`. */
export type TrainingQuotePreview = {
  quoteId: string;
  total: number;
  imageCount: number;
  modelName: string;
  epochs: number | null;
  steps: number | null;
  expiresAt: string;
  thumbnails: string[];
  /** Buzz the viewer is short by; `null` when the balance could not be read. */
  shortfall: number | null;
};

/**
 * The refusal codes the HOST itself emits. Like `CREATE_POST_HOST_ERRORS`, this is
 * the set a block can RELY on, not the set it may RECEIVE — server messages flow
 * through the same `error` field, so a validator must accept any string.
 */
export const RUN_TRAINING_HOST_ERRORS = [
  /** Mod-review sandbox with run-for-real off. */
  'review-mode',
  /** The block has not finished loading. */
  'block is not ready',
  /** Anonymous viewer — there is no account to charge. */
  'sign in to train',
  /** The payload is not a `kind:'training'` body naming a quote. */
  'invalid training request',
  /** The host holds no block token yet. */
  'no block token',
  /** The viewer dismissed the confirm. Guaranteed to mean NO run was submitted. */
  'declined',
  /**
   * The submit was SENT but its outcome is unknown: the connection was lost, or the
   * server attempted the run and could not confirm it. The run may be running and
   * charged — check the viewer's trainings before offering a retry.
   */
  'submission-unconfirmed',
] as const satisfies readonly string[];

export type RunTrainingHostError = (typeof RUN_TRAINING_HOST_ERRORS)[number];

export type RunTrainingGateDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: RunTrainingHostError }
  | {
      kind: 'proceed';
      request: { requestId: string; quoteId: string; body: Record<string, unknown> };
    };

export type TrainingBridgeGateInput = {
  raw: unknown;
  ready: boolean;
  signedIn: boolean;
  /** TRUE in the mod-review sandbox with "run for real" OFF. */
  reviewNack: boolean;
};

/** The refusals every training bridge message shares, before its own payload check. */
export type TrainingBridgePreludeError = 'review-mode' | 'block is not ready' | 'sign in to train';

/**
 * The checks every `kind:'training'` bridge message (`RUN_TRAINING`,
 * `PREPARE_TRAINING_DATASET`) runs before looking at its own payload, in one place
 * so the two cannot refuse in a different order or with different codes. Drop only
 * without a `requestId` (nothing to reply to); the order is review mode, ready,
 * signed in.
 */
export function resolveTrainingBridgePrelude(
  input: TrainingBridgeGateInput
):
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: TrainingBridgePreludeError }
  | { kind: 'ok'; requestId: string; obj: Record<string, unknown> } {
  const { raw, ready, signedIn, reviewNack } = input;
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return { kind: 'drop' };
  const requestId = obj.requestId;

  if (reviewNack) return { kind: 'refuse', requestId, error: 'review-mode' };
  if (!ready) return { kind: 'refuse', requestId, error: 'block is not ready' };
  if (!signedIn) return { kind: 'refuse', requestId, error: 'sign in to train' };
  return { kind: 'ok', requestId, obj };
}

/**
 * Validate a raw `RUN_TRAINING` payload from an untrusted iframe and decide drop /
 * refuse / proceed. SHAPE ONLY — the server re-validates the body against the wire
 * schema and the stored quote. Dropping is safe only before a `requestId` is known.
 */
export function resolveRunTrainingRequest(input: TrainingBridgeGateInput): RunTrainingGateDecision {
  const prelude = resolveTrainingBridgePrelude(input);
  if (prelude.kind !== 'ok') return prelude;
  const { requestId, obj } = prelude;

  const body = obj.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'refuse', requestId, error: 'invalid training request' };
  }
  const b = body as Record<string, unknown>;
  if (b.kind !== 'training' || typeof b.quoteId !== 'string' || b.quoteId.length === 0) {
    return { kind: 'refuse', requestId, error: 'invalid training request' };
  }
  return { kind: 'proceed', request: { requestId, quoteId: b.quoteId, body: b } };
}

export type TrainingConsentCopy = {
  title: string;
  intro: string;
  /** The price, in plain words — the line the viewer is agreeing to. */
  priceLine: string;
  /** Base model, length and dataset size. */
  details: string[];
  /** Present only when the viewer's balance is known to be short. */
  shortfallLine: string | null;
  confirmLabel: string;
};

/**
 * The copy for the training consent confirm. Every number is from `preview`;
 * `appName` is sanitized with the same anti-spoof pass the post confirm uses.
 */
export function buildTrainingConsentCopy({
  appName,
  preview,
}: {
  appName?: string | null;
  preview: TrainingQuotePreview;
}): TrainingConsentCopy {
  const who = sanitizeAppChromeName(appName) ?? 'This app';
  const images = `${preview.imageCount} image${preview.imageCount === 1 ? '' : 's'}`;
  const length = [
    preview.epochs != null ? `${preview.epochs} epoch${preview.epochs === 1 ? '' : 's'}` : null,
    preview.steps != null ? `${preview.steps} steps` : null,
  ].filter((s): s is string => s !== null);
  return {
    title: 'Start this training run?',
    intro: `${who} wants to train a LoRA on ${images} from your account.`,
    priceLine: `This run costs ${preview.total.toLocaleString(
      'en-US'
    )} Buzz, charged when it starts.`,
    details: [
      `Base model: ${preview.modelName}`,
      ...(length.length > 0 ? [`Length: ${length.join(', ')}`] : []),
      `Dataset: ${images}`,
    ],
    shortfallLine:
      preview.shortfall != null && preview.shortfall > 0
        ? `You need ${preview.shortfall.toLocaleString('en-US')} more Buzz to start this run.`
        : null,
    confirmLabel: `Train for ${preview.total.toLocaleString('en-US')} Buzz`,
  };
}

/**
 * True when a training submit failed in TRANSPORT — no tRPC error code came back,
 * so the host cannot tell whether the server ran it. A server refusal carries a code.
 */
export function isTrainingSubmitTransportError(err: unknown): boolean {
  return typeof (err as { data?: { code?: unknown } } | null | undefined)?.data?.code !== 'string';
}

export type TrainingSubmitReply = { snapshot: unknown } | { error: string };

/**
 * The `TRAINING_RESULT` payload for a submit that RETURNED. The server marks a submit
 * whose orchestrator call was attempted but whose outcome is unknown with
 * `submissionUnconfirmed: true`; the run may exist, so the block is told exactly that
 * rather than handed a failed snapshot it would read as "nothing happened".
 */
export function trainingSubmitReplyFromResult(result: {
  snapshot?: unknown;
  submissionUnconfirmed?: unknown;
}): TrainingSubmitReply {
  if (result.submissionUnconfirmed === true) return { error: 'submission-unconfirmed' };
  return { snapshot: result.snapshot };
}

/**
 * The `TRAINING_RESULT` payload for a submit that THREW. A transport failure means the
 * server may have run it — `submission-unconfirmed`, never resent (the quote is spent
 * once). If the server DID start it, a later retry of the same body is a second run.
 * A coded error is a server refusal and is passed on.
 */
export function trainingSubmitReplyFromError(err: unknown): TrainingSubmitReply {
  if (isTrainingSubmitTransportError(err)) return { error: 'submission-unconfirmed' };
  return { error: err instanceof Error ? err.message : 'unknown' };
}
