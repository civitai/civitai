import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { addToQueue, checkoutQueue } from '~/server/redis/queues';
import type { ModelMeta } from '~/server/schema/model.schema';
import { checkComFaceIntent, getOwnTriggerWords } from '~/server/services/model-sfw-face.service';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

/** One queue per attempt, so a retry carries its count; attempt 0 is a fresh edit. */
export const COM_FACE_RECHECK_MAX_ATTEMPTS = 5;
export const COM_FACE_RECHECK_GAVE_UP = `gave up after ${COM_FACE_RECHECK_MAX_ATTEMPTS} attempts without finishing the re-check`;
const queueKey = (attempt: number) =>
  attempt === 0 ? 'com-face-recheck' : `com-face-recheck:retry${attempt}`;

/**
 * Queues the intent re-check for a model whose listing (name, description or trigger words) an
 * owner just changed. Call after the write commits; it never throws, so a queue failure cannot fail
 * the save. Models without a .com face are skipped when the job runs.
 */
export async function queueComFaceRecheck(modelId: number) {
  await addToQueue(queueKey(0), modelId).catch((error) =>
    logToAxiom({
      type: 'error',
      name: 'com-face-recheck',
      message: 'enqueue failed',
      modelId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
  );
}

type RecheckResult = 'skipped' | 'allowed' | 'removed' | 'unavailable';

/**
 * Re-runs the .com face intent check on a model's current listing. When it is detected the model
 * leaves .com: the .com cover is cleared (the .com title and description stay, so the owner can
 * pick a cover again once the listing passes) and the level is recomputed.
 */
export async function recheckComFace(modelId: number): Promise<RecheckResult> {
  // Primary: the edit that queued this has just committed.
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      sfwName: true,
      sfwCoverImageId: true,
      deletedAt: true,
      meta: true,
    },
  });
  if (!model || model.deletedAt || !model.sfwName) return 'skipped';
  if (model.sfwCoverImageId == null) {
    // A removal whose follow-up failed is finished on its retry; both steps are idempotent.
    if ((model.meta as ModelMeta | null)?.comFaceRemoved) await finishRemoval(modelId);
    return 'skipped';
  }

  const triggerWords = await getOwnTriggerWords({
    modelId,
    userId: model.userId,
    db: dbWrite,
  });
  const result = await checkComFaceIntent({
    name: model.name,
    description: model.description,
    triggerWords,
  });
  if (result !== 'detected') return result;

  const coverId = model.sfwCoverImageId;
  const marker: NonNullable<ModelMeta['comFaceRemoved']> = {
    at: new Date().toISOString(),
    sfwCoverImageId: coverId,
  };
  const removed = await dbWrite.$transaction(async (tx) => {
    // Conditional on the cover read above: a cover picked since then went through the save gate.
    const updated = await tx.$executeRaw`
      UPDATE "Model"
      SET "sfwCoverImageId" = NULL,
          meta = ${asJsonbObjectSql(
            'meta'
          )} || jsonb_build_object('comFaceRemoved', ${JSON.stringify(marker)}::jsonb)
      WHERE id = ${modelId} AND "sfwCoverImageId" = ${coverId}
    `;
    if (updated)
      await tx.modActivity.create({
        data: { activity: 'removeComFace', entityType: 'model', entityId: modelId },
      });
    return updated > 0;
  });
  if (!removed) return 'skipped';

  await finishRemoval(modelId);
  return 'removed';
}

/** Drops the cover's safe bits from the model's level, which is what takes it off .com. */
async function finishRemoval(modelId: number) {
  // Imported here: model-version.service imports this module, and the level service pulls in search.
  const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
  await updateModelNsfwLevels([modelId]);
  const { bustPublicModelResponseCache } = await import('~/server/services/model-version.service');
  await bustPublicModelResponseCache(modelId);
}

/**
 * Drains every attempt queue once. All queues are checked out first and committed last, after the
 * retries are written: a retry lands in a bucket this run did not read, and a run that dies midway
 * leaves its queues to be read again rather than losing what it had not yet requeued.
 */
export async function processComFaceRechecks() {
  const counts: Record<RecheckResult | 'failed' | 'gaveUp', number> = {
    skipped: 0,
    allowed: 0,
    removed: 0,
    unavailable: 0,
    failed: 0,
    gaveUp: 0,
  };

  const queues = [];
  // In more than one queue: a fresh edit since the last failure, so the lowest attempt wins.
  const attempts = new Map<number, number>();
  for (let attempt = 0; attempt < COM_FACE_RECHECK_MAX_ATTEMPTS; attempt++) {
    const queue = await checkoutQueue(queueKey(attempt));
    queues.push(queue);
    for (const modelId of queue.content) if (!attempts.has(modelId)) attempts.set(modelId, attempt);
  }

  const retries = new Map<number, number[]>();
  for (const [modelId, attempt] of attempts) {
    const result = await recheckComFace(modelId).catch((error) => {
      logToAxiom({
        type: 'error',
        name: 'com-face-recheck',
        message: 'recheck threw',
        modelId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      return 'failed' as const;
    });
    counts[result]++;
    if (result !== 'unavailable' && result !== 'failed') continue;
    const next = attempt + 1;
    if (next < COM_FACE_RECHECK_MAX_ATTEMPTS)
      retries.set(next, [...(retries.get(next) ?? []), modelId]);
    else {
      counts.gaveUp++;
      // Kept for moderators: the face stays as it was, with no verdict on the current listing.
      await dbWrite.modActivity
        .create({
          data: { activity: 'comFaceRecheckGaveUp', entityType: 'model', entityId: modelId },
        })
        .catch(() => undefined);
      logToAxiom({
        type: 'error',
        name: 'com-face-recheck',
        message: COM_FACE_RECHECK_GAVE_UP,
        modelId,
      }).catch(() => undefined);
    }
  }

  for (const [attempt, ids] of retries) await addToQueue(queueKey(attempt), ids);
  for (const queue of queues) await queue.commit();
  return counts;
}
