import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import { unpublishModelById } from '~/server/services/model.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import type { ModelFileType } from '~/server/common/constants';
import type { ModelStatus } from '~/shared/utils/prisma/enums';

// A file whose SHA256 exactly matches a primary weights file on another creator's public, published
// model is a re-upload of that creator's work. Only primary weights count: configs, VAEs and
// training data are legitimately shared between models. Either side can be any primary type: a copy
// uploaded as 'Model' of an original stored as 'Diffusion Model' is the same bytes.
// Tiny files collide for reasons that have nothing to do with copying (empty or stub uploads).
export const DUPLICATE_HASH_MIN_SIZE_KB = 1024;

export type CrossOwnerDuplicate = {
  fileId: number;
  originalModelId: number;
  originalVersionId: number;
  originalUserId: number;
};

type Scope = { fileId: number } | { versionId: number } | { modelId: number };

function scopeFilter(scope: Scope) {
  if ('fileId' in scope) return Prisma.sql`c.id = ${scope.fileId}`;
  if ('versionId' in scope) return Prisma.sql`c."modelVersionId" = ${scope.versionId}`;
  return Prisma.sql`c."modelVersionId" IN (
    SELECT id FROM "ModelVersion" WHERE "modelId" = ${scope.modelId}
  )`;
}

/** The earliest-published public original that a file in `scope` duplicates, if any. */
export async function findCrossOwnerDuplicate({
  ownerId,
  ...scope
}: Scope & { ownerId: number }): Promise<CrossOwnerDuplicate | null> {
  const [match] = await dbWrite.$queryRaw<CrossOwnerDuplicate[]>`
    SELECT
      c.id "fileId",
      om.id "originalModelId",
      ov.id "originalVersionId",
      om."userId" "originalUserId"
    FROM "ModelFile" c
    JOIN "ModelFileHash" ch ON ch."fileId" = c.id AND ch.type = 'SHA256'
    JOIN "ModelFileHash" oh ON oh.hash = ch.hash AND oh.type = 'SHA256' AND oh."fileId" <> c.id
    JOIN "ModelFile" o ON o.id = oh."fileId" AND o.type IN (${Prisma.join(primaryModelFileTypes)})
    JOIN "ModelVersion" ov ON ov.id = o."modelVersionId"
    JOIN "Model" om ON om.id = ov."modelId"
    WHERE ${scopeFilter(scope)}
      AND c.type IN (${Prisma.join(primaryModelFileTypes)})
      AND c."sizeKB" >= ${DUPLICATE_HASH_MIN_SIZE_KB}
      AND om."userId" <> ${ownerId}
      AND om.status = 'Published'
      AND ov.status = 'Published'
      AND om.availability <> 'Private'
      AND om."deletedAt" IS NULL
    ORDER BY ov."publishedAt" ASC NULLS LAST, ov.id ASC
    LIMIT 1
  `;
  return match ?? null;
}

export function duplicateHashMessage(match: CrossOwnerDuplicate) {
  return `This model contains a file identical to one in another creator's model (/models/${match.originalModelId}?modelVersionId=${match.originalVersionId}). Re-uploading another creator's files is not allowed.`;
}

function logMatch(
  path: 'scan' | 'publish',
  action: 'unpublished' | 'blocked' | 'suppressed',
  details: Record<string, unknown>
) {
  logToAxiom(
    { type: 'info', name: 'duplicate-model-hash', message: action, path, ...details },
    'webhooks'
  ).catch(() => null);
}

const isExempt = (ownerId: number) => ownerId === constants.system.officialUserId;

export type DuplicateHashScanOutcome = 'skipped' | 'none' | 'suppressed' | 'unpublished';

/**
 * Called once a file's hashes land. Unpublishes the model when a primary model file is a byte-identical
 * copy of another creator's published one. While the kill switch is off, matches are logged only.
 */
export async function checkDuplicateHashOnScan({
  fileId,
  fileType,
  sizeKB,
  sha256,
  previousSha256,
  modelId,
  ownerId,
  modelStatus,
  modelMeta,
}: {
  fileId: number;
  fileType: string;
  sizeKB: number;
  sha256: string;
  previousSha256?: string;
  modelId: number;
  ownerId: number;
  modelStatus: ModelStatus;
  modelMeta: ModelMeta | null;
}): Promise<DuplicateHashScanOutcome> {
  if (!primaryModelFileTypes.includes(fileType as ModelFileType)) return 'skipped';
  if (sizeKB < DUPLICATE_HASH_MIN_SIZE_KB) return 'skipped';
  if (isExempt(ownerId)) return 'skipped';
  // A rescan of unchanged bytes would otherwise take down a model a moderator restored.
  if (previousSha256 && previousSha256.toUpperCase() === sha256.toUpperCase()) return 'skipped';
  // Already down by a moderator (or deleted): a reason here would overwrite theirs.
  if (constants.modPublishOnlyStatuses.includes(modelStatus)) return 'skipped';

  const match = await findCrossOwnerDuplicate({ fileId, ownerId });
  if (!match) return 'none';

  const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.DUPLICATE_MODEL_HASH_BLOCK);
  logMatch('scan', enabled ? 'unpublished' : 'suppressed', { modelId, ownerId, sha256, ...match });
  if (!enabled) return 'suppressed';

  await unpublishModelById({
    id: modelId,
    reason: 'duplicate',
    customMessage: duplicateHashMessage(match),
    meta: modelMeta ?? undefined,
    userId: constants.system.user.id,
    isModerator: true,
  });
  return 'unpublished';
}

/**
 * Publish-time half of the check, for files hashed before the original was published or before the
 * kill switch was turned on. Moderators are let through so they can restore a false positive.
 */
export async function assertNotCrossOwnerDuplicate({
  ownerId,
  isModerator,
  ...scope
}: ({ versionId: number } | { modelId: number }) & { ownerId: number; isModerator?: boolean }) {
  if (isModerator || isExempt(ownerId)) return;

  const match = await findCrossOwnerDuplicate({ ownerId, ...scope });
  if (!match) return;

  const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.DUPLICATE_MODEL_HASH_BLOCK);
  logMatch('publish', enabled ? 'blocked' : 'suppressed', { ownerId, ...scope, ...match });
  if (!enabled) return;

  throw throwBadRequestError(duplicateHashMessage(match));
}
