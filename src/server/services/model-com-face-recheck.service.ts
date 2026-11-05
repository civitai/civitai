import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { addToQueue, checkoutQueue } from '~/server/redis/queues';
import type { ComFaceRemovedReason, ModelMeta } from '~/server/schema/model.schema';
import { checkComFaceIntent, getOwnTriggerWords } from '~/server/services/model-sfw-face.service';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

const QUEUE = 'com-face-recheck';
/** A model whose check got no verdict waits in a KeyValue row under this prefix until its next try. */
const RETRY_KEY_PREFIX = 'com-face-recheck:';

/** Retries back off from the first delay, doubling up to the max, until the window since the oldest
 *  edit still without a verdict runs out. */
export const COM_FACE_RECHECK_FIRST_DELAY_MS = 60_000;
export const COM_FACE_RECHECK_MAX_DELAY_MS = 60 * 60_000;
export const COM_FACE_RECHECK_WINDOW_MS = 24 * 60 * 60_000;
export const COM_FACE_RECHECK_GAVE_UP = 'gave up without a verdict; took the face off civitai.com';

type RetryState = { since: string; attempt: number; nextAt: string };

/**
 * Queues the intent re-check for a model whose listing (name, description or trigger words) an
 * owner just changed. Call after the write commits; it never throws, so a queue failure cannot fail
 * the save. Models without a .com face are skipped when the job runs.
 *
 * When the queue is unavailable the edit goes in as a due retry row instead, under the same window
 * as any check without a verdict; when that write fails too the face comes off .com now. An edit
 * that reaches neither must not keep its face up unchecked.
 */
export async function queueComFaceRecheck(modelId: number) {
  // `false` means some id missed Redis; the Postgres parking lot behind it can drop ids silently.
  const queued = await addToQueue(QUEUE, modelId).catch((error) => {
    logError('enqueue failed', modelId, error);
    return false;
  });
  if (!queued) await fallBackFromQueue(modelId);
}

/** The retry-row write: a model already waiting keeps its deadline and only the backoff restarts,
 *  as for a fresh edit. */
export const dueRetryRowSql = (modelId: number, since: Date) => {
  const value: RetryState = { since: since.toISOString(), attempt: 0, nextAt: '' };
  return Prisma.sql`
    INSERT INTO "KeyValue" (key, value) VALUES (${retryKey(modelId)}, ${JSON.stringify(
    value
  )}::jsonb)
    ON CONFLICT (key) DO UPDATE
    SET value = "KeyValue".value || '{"attempt":0,"nextAt":""}'::jsonb
  `;
};

async function fallBackFromQueue(modelId: number) {
  try {
    await dbWrite.$executeRaw(dueRetryRowSql(modelId, new Date()));
    return;
  } catch (error) {
    logError('enqueue fallback retry row failed', modelId, error);
  }
  await removeUnverified(modelId).catch((error) =>
    logError('enqueue fallback removal failed', modelId, error)
  );
}

type RecheckResult = 'skipped' | 'allowed' | 'removed' | 'unavailable';

async function readModel(modelId: number) {
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
  return model && !model.deletedAt && model.sfwName ? model : null;
}

/**
 * Re-runs the .com face intent check on a model's current listing. When it is detected the model
 * leaves .com: the .com cover is cleared (the .com title and description stay, so the owner can
 * pick a cover again once the listing passes) and the level is recomputed.
 */
export async function recheckComFace(modelId: number): Promise<RecheckResult> {
  const model = await readModel(modelId);
  if (!model) return 'skipped';
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
  return (await removeComFace(modelId, model.sfwCoverImageId, 'detected')) ? 'removed' : 'skipped';
}

/** Takes the model off .com without a verdict: the check never answered inside the window. Returns
 *  whether this call took it off; throws when that cannot be finished, so the retry stays. */
async function removeUnverified(modelId: number) {
  const model = await readModel(modelId);
  if (!model) return false;
  if (model.sfwCoverImageId == null) {
    if ((model.meta as ModelMeta | null)?.comFaceRemoved) await finishRemoval(modelId);
    return false;
  }
  // No row updated: a cover picked since the read went through the save gate and queued its own check.
  return removeComFace(modelId, model.sfwCoverImageId, 'recheck-unverified');
}

/** Clears the .com cover and records the marker, only while the cover is still the one read: a cover
 *  picked since then went through the save gate. */
export const comFaceRemovalSql = (
  modelId: number,
  coverId: number,
  marker: NonNullable<ModelMeta['comFaceRemoved']>
) => {
  const meta = asJsonbObjectSql('meta');
  const markerJson = JSON.stringify(marker);
  return Prisma.sql`
    UPDATE "Model"
    SET "sfwCoverImageId" = NULL,
        meta = ${meta} || jsonb_build_object('comFaceRemoved', ${markerJson}::jsonb)
    WHERE id = ${modelId} AND "sfwCoverImageId" = ${coverId}
  `;
};

async function removeComFace(modelId: number, coverId: number, reason: ComFaceRemovedReason) {
  const marker: NonNullable<ModelMeta['comFaceRemoved']> = {
    at: new Date().toISOString(),
    sfwCoverImageId: coverId,
    reason,
  };
  const removed = await dbWrite.$transaction(async (tx) => {
    const updated = await tx.$executeRaw(comFaceRemovalSql(modelId, coverId, marker));
    if (updated)
      await tx.modActivity.create({
        data: {
          activity: reason === 'detected' ? 'removeComFace' : 'comFaceRecheckGaveUp',
          entityType: 'model',
          entityId: modelId,
        },
      });
    return updated > 0;
  });
  if (removed) await finishRemoval(modelId);
  return removed;
}

/** Drops the cover's safe bits from the model's level, which is what takes it off .com. */
async function finishRemoval(modelId: number) {
  // Imported here: the level service pulls in search.
  const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
  await updateModelNsfwLevels([modelId]);
  // Imported here: model-version.service imports this module.
  const { bustPublicModelResponseCache } = await import('~/server/services/model-version.service');
  await bustPublicModelResponseCache(modelId);
}

const retryKey = (modelId: number) => `${RETRY_KEY_PREFIX}${modelId}`;
const retryDelay = (attempt: number) =>
  Math.min(COM_FACE_RECHECK_FIRST_DELAY_MS * 2 ** (attempt - 1), COM_FACE_RECHECK_MAX_DELAY_MS);
/** A run stops taking new models after this, inside the job lock; the rest wait for the next run. */
const RUN_BUDGET_MS = 4 * 60_000;

function logError(message: string, modelId: number, error?: unknown) {
  logToAxiom({
    type: 'error',
    name: 'com-face-recheck',
    message,
    modelId,
    ...(error !== undefined && {
      error: error instanceof Error ? error.message : String(error),
    }),
  }).catch(() => undefined);
}

/**
 * Runs the fresh edits and the retries that are due. A fresh edit on a model already waiting on a
 * retry runs now and resets the backoff, but keeps the deadline of the oldest edit still without a
 * verdict. A model whose bookkeeping throws is logged and left for the next run (a fresh edit is
 * queued again), so one bad model never holds up the rest.
 */
export async function processComFaceRechecks(now = new Date()) {
  const startedAt = Date.now();
  const counts: Record<RecheckResult | 'failed' | 'gaveUp' | 'errored', number> = {
    skipped: 0,
    allowed: 0,
    removed: 0,
    unavailable: 0,
    failed: 0,
    gaveUp: 0,
    errored: 0,
  };

  const queue = await checkoutQueue(QUEUE);
  const fresh = new Set(queue.content);
  // Due retries go first: a backlog of fresh edits must not hold back a face that is out of time.
  const work = new Map<number, RetryState | null>();
  const waiting = await dbWrite.keyValue.findMany({
    where: { key: { startsWith: RETRY_KEY_PREFIX } },
  });
  const waitingSince = new Map<number, string>();
  for (const row of waiting) {
    const modelId = Number(row.key.slice(RETRY_KEY_PREFIX.length));
    if (!Number.isInteger(modelId) || retryKey(modelId) !== row.key) continue;
    const state = (row.value ?? {}) as Partial<RetryState>;
    // An unreadable start counts as out of time and an unreadable nextAt as due, so both fail closed.
    const since = Number.isFinite(Date.parse(state.since ?? ''))
      ? state.since!
      : new Date(0).toISOString();
    waitingSince.set(modelId, since);
    const nextAt = Date.parse(state.nextAt ?? '');
    if (!(nextAt > now.getTime()))
      work.set(modelId, {
        since,
        attempt: Number.isInteger(state.attempt) ? Math.max(0, state.attempt!) : 0,
        nextAt: state.nextAt ?? '',
      });
  }
  // A fresh edit restarts the backoff only; the deadline stays with the oldest unverified edit.
  for (const modelId of fresh) {
    const since = waitingSince.get(modelId);
    work.set(modelId, since ? { since, attempt: 0, nextAt: '' } : null);
  }

  const requeue: number[] = [];
  for (const [modelId, state] of work) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      if (fresh.has(modelId)) requeue.push(modelId);
      continue;
    }
    try {
      const result = await recheckComFace(modelId).catch((error) => {
        logError('recheck threw', modelId, error);
        return 'failed' as const;
      });
      counts[result]++;

      if (result !== 'unavailable' && result !== 'failed') {
        if (waitingSince.has(modelId))
          await dbWrite.keyValue.deleteMany({ where: { key: retryKey(modelId) } });
        continue;
      }

      const since = state?.since ?? now.toISOString();
      if (now.getTime() - new Date(since).getTime() >= COM_FACE_RECHECK_WINDOW_MS) {
        // Fail closed: no verdict on the current listing means the face does not stay up.
        const removed = await removeUnverified(modelId);
        await dbWrite.keyValue.deleteMany({ where: { key: retryKey(modelId) } });
        if (removed) {
          counts.gaveUp++;
          logError(COM_FACE_RECHECK_GAVE_UP, modelId);
        }
        continue;
      }

      const attempt = (state?.attempt ?? 0) + 1;
      const value: RetryState = {
        since,
        attempt,
        // From now, not the run's start: a long run would otherwise write a retry already due.
        nextAt: new Date(
          now.getTime() + (Date.now() - startedAt) + retryDelay(attempt)
        ).toISOString(),
      };
      await dbWrite.keyValue.upsert({
        where: { key: retryKey(modelId) },
        create: { key: retryKey(modelId), value },
        update: { value },
      });
    } catch (error) {
      counts.errored++;
      logError('recheck bookkeeping failed', modelId, error);
      if (fresh.has(modelId)) requeue.push(modelId);
    }
  }

  if (requeue.length) {
    const queued = await addToQueue(QUEUE, requeue).catch((error) => {
      logError('requeue failed', requeue[0], error);
      return false;
    });
    if (!queued) for (const modelId of requeue) await fallBackFromQueue(modelId);
  }
  await queue.commit();
  return counts;
}
