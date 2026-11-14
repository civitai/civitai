import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { ComFaceIntentRecord, ModelMeta } from '~/server/schema/model.schema';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import type { TextScanField } from '~/server/services/text-scan/types';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import { removeTags } from '~/utils/string-helpers';

/** `meta.systemNsfwLock.source` on a lock the listing intent check added at .com-face time. */
export const COM_FACE_INTENT_LOCK_SOURCE = 'com-face-intent';

export type ComFaceIntentListing = {
  name: string;
  description?: string | null;
  triggerWords: string[];
};

/** The fields the intent check reads: the model's own listing, as civitai.red shows it. */
export function comFaceIntentFields({
  name,
  description,
  triggerWords,
}: ComFaceIntentListing): TextScanField[] {
  const text = removeTags(description ?? '').trim();
  return [
    { heading: 'Name', text: name },
    ...(text ? [{ heading: 'Description', text }] : []),
    ...(triggerWords.length ? [{ heading: 'Trained words', text: triggerWords.join(', ') }] : []),
  ];
}

export const comFaceIntentTextHash = (listing: ComFaceIntentListing) =>
  textScanTextHash({ fields: comFaceIntentFields(listing), declared: {} });

/** The stored verdict, while it was read from this exact listing text. */
export function reusableComFaceIntent(
  meta: unknown,
  textHash: string
): Pick<ComFaceIntentRecord, 'detected' | 'reason'> | null {
  const record = (meta as ModelMeta | null)?.comFaceIntent;
  if (!record || typeof record !== 'object' || record.textHash !== textHash) return null;
  if (typeof record.detected !== 'boolean') return null;
  // An overturned detection stands as allowed for the text it was ruled on.
  return { detected: record.detected && !record.overturnedAt, reason: record.reason };
}

export async function readComFaceIntentModel(modelId: number) {
  return dbWrite.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      nsfw: true,
      minor: true,
      poi: true,
      sfwOnly: true,
      lockedProperties: true,
      meta: true,
    },
  });
}

/** Stores a fresh verdict for the listing text it read. Best effort: a failed write only costs a
 *  re-judgement next time. */
export async function recordComFaceIntent(
  modelId: number,
  record: Omit<ComFaceIntentRecord, 'at'>
) {
  const value = JSON.stringify({ ...record, at: new Date().toISOString() });
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET meta = ${asJsonbObjectSql('meta')} || jsonb_build_object('comFaceIntent', ${value}::jsonb)
    WHERE id = ${modelId}
  `.catch((error: Error) =>
    logToAxiom({
      type: 'error',
      name: 'model-com-face-intent',
      message: 'verdict not stored',
      modelId,
      error: error.message,
    })
  );
}

/**
 * A sexual-intent detection on a mature model's own stored listing: the model is made for sexual
 * content, so its nsfw rating is locked, with the system marker so the owner can dispute it through
 * a locked-setting review. Guarded in the WHERE: only while the stored verdict is still this
 * detection for this text, not overturned, and no lock, minor or real-person flag is on.
 * A model that is not mature keeps listing by its images, so it is refused a face but not locked.
 * A text-scan rating marker it replaces is kept on the verdict and put back when the lock is lifted
 * (`overturnComFaceIntentSql`): an allowed dispute rules on the intent, not on the rating.
 */
export async function lockForComFaceIntent(modelId: number, textHash: string) {
  const locked = await dbWrite.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "Model" m
      SET "lockedProperties" = array_append(COALESCE(m."lockedProperties", ARRAY[]::text[]), 'nsfw'),
          meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
            'systemNsfwLock',
            jsonb_build_object('source', ${COM_FACE_INTENT_LOCK_SOURCE}::text, 'at', now()),
            'comFaceIntent',
            (m.meta->'comFaceIntent') || CASE
              WHEN jsonb_typeof(m.meta->'systemNsfwLock') = 'object'
              THEN jsonb_build_object('priorSystemNsfwLock', m.meta->'systemNsfwLock')
              ELSE '{}'::jsonb END
          )
      WHERE m.id = ${modelId}
        AND m.nsfw AND NOT m.minor AND NOT m.poi AND NOT m."sfwOnly"
        AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
        AND m.meta->'comFaceIntent'->>'textHash' = ${textHash}
        AND m.meta->'comFaceIntent'->>'detected' = 'true'
        AND NOT (m.meta->'comFaceIntent' ? 'overturnedAt')
    `;
    if (updated)
      await tx.modActivity.create({
        data: { activity: 'comFaceIntentLock', entityType: 'model', entityId: modelId },
      });
    return updated > 0;
  });
  if (locked) await preventReplicationLag('model', modelId);
  return locked;
}

/** Marks the stored detection overturned (a dispute or a moderator lifted its lock) and puts back
 *  the rating marker its lock replaced. Runs after the caller cleared the lock's own marker. */
export const overturnComFaceIntentSql = (modelId: number) => Prisma.sql`
  UPDATE "Model"
  SET meta = jsonb_set(meta, '{comFaceIntent,overturnedAt}', to_jsonb(now()::text)) || CASE
    WHEN jsonb_typeof(meta->'comFaceIntent'->'priorSystemNsfwLock') = 'object'
    THEN jsonb_build_object('systemNsfwLock', meta->'comFaceIntent'->'priorSystemNsfwLock')
    ELSE '{}'::jsonb END
  WHERE id = ${modelId}
    AND jsonb_typeof(meta->'comFaceIntent') = 'object'
    AND meta->'comFaceIntent'->>'detected' = 'true'
    AND NOT (meta->'comFaceIntent' ? 'overturnedAt')
`;
