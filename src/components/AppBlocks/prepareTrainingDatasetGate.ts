import type * as z from 'zod';
import { createPostSettlement } from '~/components/AppBlocks/createPostFromAppGate';
import {
  resolveTrainingBridgePrelude,
  type TrainingBridgeGateInput,
} from '~/components/AppBlocks/runTrainingGate';
import { blockTrainingDatasetItemsSchema } from '~/server/schema/blocks/training-dataset.schema';
import type { BlockTrainingRejectionReason } from '~/server/services/blocks/block-training-dataset.service';

/**
 * The decision layer for the `PREPARE_TRAINING_DATASET` host bridge (App Blocks
 * `kind:'training'`, step 1 of the block flow). PURE apart from the injected
 * `prepare` call, and host-agnostic, like `runTrainingGate.ts`.
 *
 * ## Why a bridge
 *
 * `blocks.prepareTrainingDataset` takes the page's block token, but a block cannot
 * call a tRPC procedure itself: its iframe is a different origin, and the web tRPC
 * endpoint refuses foreign origins. So the PAGE host makes the call for it, as it
 * does for the estimate and the submit:
 *
 *   `PREPARE_TRAINING_DATASET { requestId, items: [{ imageId, caption }] }`
 *     → `TRAINING_DATASET_RESULT { requestId, result: { datasetId, count, rejected } }`
 *     | `TRAINING_DATASET_RESULT { requestId, error }`
 *
 * No dialog: preparing a dataset charges nothing. It reads only the viewer's own
 * images that pass the server's gates and returns an opaque handle; the run that
 * would spend Buzz is confirmed separately on `RUN_TRAINING`.
 *
 * 🔴 THE HOST CHECK IS SHAPE ONLY. `items` is validated against the server's own
 * `blockTrainingDatasetItemsSchema` so a malformed or oversized payload is refused
 * here with a legible error instead of a server round trip. The server re-validates
 * the same schema and owns every real gate (ownership, maturity, moderation, rate
 * limit, flag, scope).
 *
 * Only `PageBlockHost` registers a handler. The model slot has none; the shared
 * dispatcher NACKs the message there with a `TRAINING_DATASET_RESULT` error, from
 * the `hostHandlerParity` INVENTORY entry. Training is page-only on the server too.
 */

export type TrainingDatasetItems = z.infer<typeof blockTrainingDatasetItemsSchema>;

/** The `TRAINING_DATASET_RESULT` success payload. Mirrors `blocks.prepareTrainingDataset`. */
export type PreparedTrainingDataset = {
  datasetId: string;
  count: number;
  rejected: Array<{ imageId: number; reason: BlockTrainingRejectionReason }>;
};

/**
 * The refusal codes the HOST itself emits. The set a block can RELY on, not the
 * set it may RECEIVE: server messages arrive in the same `error` field. The first
 * three come from the shared training prelude (`resolveTrainingBridgePrelude`), so
 * they read exactly as `RUN_TRAINING`'s do.
 */
export const PREPARE_TRAINING_DATASET_HOST_ERRORS = [
  /** Mod-review sandbox with run-for-real off. */
  'review-mode',
  /** The block has not finished loading. */
  'block is not ready',
  /** Anonymous viewer — there are no images of theirs to read. */
  'sign in to train',
  /** `items` failed the server's dataset item schema (shape, count or caption length). */
  'invalid training dataset',
  /** The host holds no block token yet. */
  'no block token',
] as const satisfies readonly string[];

export type PrepareTrainingDatasetHostError = (typeof PREPARE_TRAINING_DATASET_HOST_ERRORS)[number];

export type PrepareTrainingDatasetDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: PrepareTrainingDatasetHostError }
  | { kind: 'proceed'; request: { requestId: string; items: TrainingDatasetItems } };

/**
 * Validate a raw `PREPARE_TRAINING_DATASET` payload from an untrusted iframe and
 * decide drop / refuse / proceed. Dropping is safe only before a `requestId` is
 * known; every later refusal carries a reply.
 */
export function resolvePrepareTrainingDatasetRequest(
  input: TrainingBridgeGateInput
): PrepareTrainingDatasetDecision {
  const prelude = resolveTrainingBridgePrelude(input);
  if (prelude.kind !== 'ok') return prelude;
  const { requestId, obj } = prelude;

  const parsed = blockTrainingDatasetItemsSchema.safeParse(obj.items);
  if (!parsed.success) return { kind: 'refuse', requestId, error: 'invalid training dataset' };
  return { kind: 'proceed', request: { requestId, items: parsed.data } };
}

/**
 * The reply for a prepare that RETURNED: the documented fields, copied by name
 * (down to each rejection entry) so nothing else the procedure may grow reaches
 * the block unreviewed.
 */
export function trainingDatasetReplyFromResult(result: PreparedTrainingDataset): {
  result: PreparedTrainingDataset;
} {
  return {
    result: {
      datasetId: result.datasetId,
      count: result.count,
      rejected: result.rejected.map(({ imageId, reason }) => ({ imageId, reason })),
    },
  };
}

/**
 * Run one `PREPARE_TRAINING_DATASET` request end to end: decide, call the procedure
 * with the page's block token, and reply exactly once on `TRAINING_DATASET_RESULT`.
 * The host supplies its own facts and transport; `prepare` is
 * `blocks.prepareTrainingDataset`.
 */
export async function handlePrepareTrainingDataset(opts: {
  raw: unknown;
  ready: boolean;
  signedIn: boolean;
  reviewNack: boolean;
  token: string | null | undefined;
  prepare: (input: {
    blockToken: string;
    items: TrainingDatasetItems;
  }) => Promise<PreparedTrainingDataset>;
  send: (type: 'TRAINING_DATASET_RESULT', payload: Record<string, unknown>) => void;
  onNoToken?: () => void;
}): Promise<void> {
  const { raw, ready, signedIn, reviewNack, token, prepare, send, onNoToken } = opts;
  const gate = resolvePrepareTrainingDatasetRequest({ raw, ready, signedIn, reviewNack });
  if (gate.kind === 'drop') return;
  if (gate.kind === 'refuse') {
    send('TRAINING_DATASET_RESULT', { requestId: gate.requestId, error: gate.error });
    return;
  }
  const { requestId, items } = gate.request;
  const settlement = createPostSettlement({
    requestId,
    emit: (payload) => send('TRAINING_DATASET_RESULT', payload),
  });
  if (!token) {
    onNoToken?.();
    settlement.reply({ error: 'no block token' });
    return;
  }
  try {
    const result = await prepare({ blockToken: token, items });
    settlement.reply(trainingDatasetReplyFromResult(result));
  } catch (err) {
    settlement.reply({ error: err instanceof Error ? err.message : 'unknown' });
  }
}
