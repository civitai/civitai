import { createHash } from 'crypto';

/**
 * Checkpoint mode of the resource-intent primitive (`kind: 'checkpoint'`): the two arms as the
 * offline checkpoint screen defined them. Imports nothing from the app, so a study script can load
 * it.
 *
 * - ATTACH_BM (`attach_bm`, served): the checkpoint models attached most often in the training
 *   images, counted within the caller's baseModel; the top `CHECKPOINT_ATTACH_CANDIDATES` by count
 *   (ties by ascending model id) go through the matcher's gate, re-sorted by count rank, one version
 *   per model, first `CHECKPOINT_LIST_MODELS`.
 * - BASE_BM (`base_bm`, the comparator): thumbs-up popularity within the baseModel, one version per
 *   model, first `CHECKPOINT_LIST_MODELS` (the matcher's popularity page, as POOL_MERGE's BASE).
 *
 * Neither reads the prompt: both lists depend only on the baseModel, the gates and (ATTACH_BM) the
 * snapshot. No vendor call is made in checkpoint mode.
 */

export const CHECKPOINT_ARMS = ['attach_bm', 'base_bm'] as const;
export type CheckpointArm = (typeof CHECKPOINT_ARMS)[number];

/** Ranked attachment candidates handed to the gate (the screen's `candTopK`). */
export const CHECKPOINT_ATTACH_CANDIDATES = 300;
/**
 * The width both arms were screened at, and the most checkpoint mode ever returns. A narrower
 * request gets this list's prefix; a wider one gets these 50, as on POOL_MERGE.
 */
export const CHECKPOINT_LIST_MODELS = 50;

/** Model ids by attachment count, descending, ties by ascending id (the screen's `rankCounts`). */
export function rankAttachCounts(m: ReadonlyMap<number, number> | undefined): number[] {
  if (!m) return [];
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}

/**
 * Hashes the serving constants and the ranking's output on a fixture, so the cache key and the
 * shadow row move when either does.
 */
function checkpointFingerprint() {
  return {
    arms: CHECKPOINT_ARMS,
    candidates: CHECKPOINT_ATTACH_CANDIDATES,
    listModels: CHECKPOINT_LIST_MODELS,
    ranked: rankAttachCounts(
      new Map([
        [9, 2],
        [3, 7],
        [5, 2],
        [1, 1],
      ])
    ),
  };
}

export const RESOURCE_INTENT_CHECKPOINT_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(checkpointFingerprint()))
  .digest('hex');
