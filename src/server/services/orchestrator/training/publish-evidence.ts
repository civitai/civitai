import { dbWrite } from '~/server/db/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * Server-owned training meta flags (see `SERVER_OWNED_META_KEYS`) and the publish-evidence rule the
 * training moderation check falls back on when a model's workflow can no longer be read. Kept apart
 * from `publish-from-workflow.ts` so `model.service.ts` can use it without an import cycle.
 */

type TrainingFlag = 'trainingStudioModerationApproved' | 'trainingStudioPublishedBeforeStamp';

/**
 * Set one boolean server-owned meta flag to true, as a single-key write so a concurrent meta write
 * is not overwritten. Best-effort: a failure is logged and the flag stays unset.
 */
export async function setServerOwnedMetaFlag(modelId: number, key: TrainingFlag): Promise<void> {
  try {
    await dbWrite.$executeRaw`
      UPDATE "Model"
      SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), ARRAY[${key}]::text[], 'true'::jsonb)
      WHERE id = ${modelId}
    `;
  } catch (error) {
    console.error(`setting ${key} failed (model ${modelId}):`, error);
  }
}

type EvidenceModel = { meta: unknown; status: ModelStatus; publishedAt: Date | null };

/**
 * True when a training-studio-born model carries neither the approval stamp nor the
 * published-before-stamp marker, but its row shows it was published: a `publishedAt`, or a current
 * `Published` status (a private publish sets the status but not the model's `publishedAt`).
 */
export function hasUnrecordedPublishEvidence(model: EvidenceModel): boolean {
  const meta = model.meta as ModelMeta | null | undefined;
  if (!meta?.trainingStudioWorkflowId) return false;
  if (meta.trainingStudioModerationApproved === true) return false;
  if (meta.trainingStudioPublishedBeforeStamp === true) return false;
  return model.publishedAt != null || model.status === ModelStatus.Published;
}

/**
 * For a path that clears a model's status or `publishedAt` AND rewrites its meta (unpublish, set to
 * draft): the marker to merge into the meta it writes, computed from the row it is about to change.
 * A separate flag write would be overwritten by that meta write.
 */
export function publishEvidenceMarker(model: EvidenceModel): Partial<ModelMeta> {
  return hasUnrecordedPublishEvidence(model) ? { trainingStudioPublishedBeforeStamp: true } : {};
}

/**
 * For a path that clears a model's status or `publishedAt` without rewriting its meta (delete):
 * records the publish evidence as the server-owned marker first, so the training moderation check
 * still sees it afterwards.
 */
export async function preserveTrainingPublishEvidence(modelId: number): Promise<void> {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { meta: true, status: true, publishedAt: true },
  });
  if (model && hasUnrecordedPublishEvidence(model))
    await setServerOwnedMetaFlag(modelId, 'trainingStudioPublishedBeforeStamp');
}
