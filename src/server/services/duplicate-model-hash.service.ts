import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
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

// A file held by this many distinct owners is a commonly shared file (a base or merged checkpoint
// many creators re-host), not one creator's work, so it is never auto-blocked. Only owners with a
// live copy count, plus the uploader.
export const DUPLICATE_HASH_SHARED_OWNER_THRESHOLD = 3;

export type CrossOwnerDuplicate = {
  fileId: number;
  modelId: number;
  sha256: string;
  originalModelId: number;
  originalVersionId: number;
  originalUserId: number;
  originalFileId: number;
  ownerCount: number;
  earliestHolderUserId: number;
  earliestHolderFileId: number;
};

type Scope = { fileId: number } | { versionId: number } | { modelId: number };
type ResolvedScope = { fileId: number } | { versionIds: number[] };

// A model scope is resolved to its version ids before the query runs. Written as a sub-select, the
// planner cannot see how few files it selects, so it joins every published primary file first:
// ~55s per publish on production, against under a millisecond for the same query given literal ids.
async function resolveScope(scope: Scope): Promise<ResolvedScope> {
  if ('fileId' in scope) return scope;
  if ('versionId' in scope) return { versionIds: [scope.versionId] };
  const versions = await dbWrite.modelVersion.findMany({
    where: { modelId: scope.modelId },
    select: { id: true },
  });
  return { versionIds: versions.map((v) => v.id) };
}

function scopeFilter(scope: ResolvedScope) {
  if ('fileId' in scope) return Prisma.sql`c.id = ${scope.fileId}`;
  return Prisma.sql`c."modelVersionId" IN (${Prisma.join(scope.versionIds)})`;
}

type CandidateRow = CrossOwnerDuplicate & { ownerFirstFileId: number };

/**
 * Only a file uploaded before the owner's own first copy of those bytes counts as the original.
 * Otherwise a creator whose work was copied would be matched against the copy: on republishing it,
 * or on uploading the same weights again in a new version. ModelFile ids are assigned in upload order.
 */
export function pickOriginal(rows: CandidateRow[]): CrossOwnerDuplicate | null {
  const row = rows.find((r) => r.originalFileId < r.ownerFirstFileId);
  if (!row) return null;
  const { ownerFirstFileId: _, ...match } = row;
  return match;
}

export type DuplicateDecision =
  | { action: 'block'; reason: 'cross-owner-copy' }
  | { action: 'exempt'; reason: 'shared-file' }
  | { action: 'review'; reason: 'original-not-earliest-holder' };

export function decideDuplicate(match: CrossOwnerDuplicate): DuplicateDecision {
  if (match.ownerCount >= DUPLICATE_HASH_SHARED_OWNER_THRESHOLD)
    return { action: 'exempt', reason: 'shared-file' };
  // The chosen original is the earliest-published live copy. When an earlier holder's copy is
  // unpublished or deleted, the chosen one may itself be a copy, so a person decides.
  if (match.earliestHolderUserId !== match.originalUserId)
    return { action: 'review', reason: 'original-not-earliest-holder' };
  return { action: 'block', reason: 'cross-owner-copy' };
}

/**
 * The earliest-published public original that a file in `scope` duplicates, if any, with how many
 * owners hold the file and who uploaded it first.
 */
export async function findCrossOwnerDuplicate({
  ownerId,
  ...scope
}: Scope & { ownerId: number }): Promise<CrossOwnerDuplicate | null> {
  const resolved = await resolveScope(scope);
  if ('versionIds' in resolved && !resolved.versionIds.length) return null;
  const rows = await dbWrite.$queryRaw<CandidateRow[]>`
    SELECT
      c.id "fileId",
      cv."modelId" "modelId",
      ch.hash "sha256",
      om.id "originalModelId",
      ov.id "originalVersionId",
      om."userId" "originalUserId",
      o.id "originalFileId",
      (
        SELECT min(f.id)
        FROM "ModelFileHash" h
        JOIN "ModelFile" f ON f.id = h."fileId"
        JOIN "ModelVersion" v ON v.id = f."modelVersionId"
        JOIN "Model" m ON m.id = v."modelId"
        WHERE h.hash = ch.hash AND h.type = 'SHA256' AND m."userId" = ${ownerId}
      ) "ownerFirstFileId",
      (
        SELECT count(DISTINCT m."userId")::int
        FROM "ModelFileHash" h
        JOIN "ModelFile" f ON f.id = h."fileId" AND f.type IN (${Prisma.join(
          primaryModelFileTypes
        )})
        JOIN "ModelVersion" v ON v.id = f."modelVersionId"
        JOIN "Model" m ON m.id = v."modelId"
        WHERE h.hash = ch.hash AND h.type = 'SHA256'
          AND (
            m."userId" = ${ownerId}
            OR (
              m.status = 'Published' AND v.status = 'Published'
              AND m.availability <> 'Private' AND m."deletedAt" IS NULL
            )
          )
      ) "ownerCount",
      eh."userId" "earliestHolderUserId",
      eh."fileId" "earliestHolderFileId"
    FROM "ModelFile" c
    JOIN "ModelVersion" cv ON cv.id = c."modelVersionId"
    JOIN "ModelFileHash" ch ON ch."fileId" = c.id AND ch.type = 'SHA256'
    JOIN "ModelFileHash" oh ON oh.hash = ch.hash AND oh.type = 'SHA256' AND oh."fileId" <> c.id
    JOIN "ModelFile" o ON o.id = oh."fileId" AND o.type IN (${Prisma.join(primaryModelFileTypes)})
    JOIN "ModelVersion" ov ON ov.id = o."modelVersionId"
    JOIN "Model" om ON om.id = ov."modelId"
    -- Earliest other-owner upload of these bytes, in any status.
    JOIN LATERAL (
      SELECT f.id "fileId", m."userId"
      FROM "ModelFileHash" h
      JOIN "ModelFile" f ON f.id = h."fileId" AND f.type IN (${Prisma.join(primaryModelFileTypes)})
      JOIN "ModelVersion" v ON v.id = f."modelVersionId"
      JOIN "Model" m ON m.id = v."modelId"
      WHERE h.hash = ch.hash AND h.type = 'SHA256' AND m."userId" <> ${ownerId}
      ORDER BY f.id ASC
      LIMIT 1
    ) eh ON true
    WHERE ${scopeFilter(resolved)}
      AND c.type IN (${Prisma.join(primaryModelFileTypes)})
      AND c."sizeKB" >= ${DUPLICATE_HASH_MIN_SIZE_KB}
      AND om."userId" <> ${ownerId}
      AND om.status = 'Published'
      AND ov.status = 'Published'
      AND om.availability <> 'Private'
      AND om."deletedAt" IS NULL
    ORDER BY ov."publishedAt" ASC NULLS LAST, ov.id ASC
  `;
  return pickOriginal(rows);
}

export function duplicateHashMessage(match: CrossOwnerDuplicate) {
  return `This model contains a file identical to one in another creator's model (/models/${match.originalModelId}?modelVersionId=${match.originalVersionId}). Re-uploading another creator's files is not allowed.`;
}

// Axiom: name 'duplicate-model-hash'. message is the outcome: 'unpublished' / 'blocked' (flag on),
// 'would-block' (flag off), 'exempt' or 'review-needed' (either way).
type LogMessage = 'unpublished' | 'blocked' | 'would-block' | 'exempt' | 'review-needed';

function logDecision(
  path: 'scan' | 'publish',
  message: LogMessage,
  match: CrossOwnerDuplicate,
  decision: DuplicateDecision,
  details: Record<string, unknown>
) {
  logToAxiom(
    {
      type: 'info',
      name: 'duplicate-model-hash',
      message,
      path,
      decision: decision.action,
      reason: decision.reason,
      ...match,
      ...details,
    },
    'webhooks'
  ).catch(() => null);
}

const logMessageFor = (decision: DuplicateDecision, acted: LogMessage): LogMessage => {
  if (decision.action === 'exempt') return 'exempt';
  if (decision.action === 'review') return 'review-needed';
  return acted;
};

const isExempt = (ownerId: number) => ownerId === constants.system.officialUserId;

export type DuplicateHashScanOutcome =
  | 'skipped'
  | 'none'
  | 'exempt'
  | 'review'
  | 'would-block'
  | 'unpublished';

/**
 * Called once a file's hashes land. Unpublishes the model when a primary model file is a byte-identical
 * copy of another creator's published one. Shared files and doubtful originals are logged, not acted
 * on; while the kill switch is off, every match is logged only.
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
}: {
  fileId: number;
  fileType: string;
  sizeKB: number;
  sha256: string;
  previousSha256?: string;
  modelId: number;
  ownerId: number;
  modelStatus: ModelStatus;
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

  const decision = decideDuplicate(match);
  const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.DUPLICATE_MODEL_HASH_BLOCK);
  const message = logMessageFor(decision, enabled ? 'unpublished' : 'would-block');
  logDecision('scan', message, match, decision, { modelId, ownerId, flagEnabled: enabled });
  if (decision.action !== 'block') return decision.action;
  if (!enabled) return 'would-block';

  await unpublishModelById({
    id: modelId,
    reason: 'duplicate',
    customMessage: duplicateHashMessage(match),
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

  const decision = decideDuplicate(match);
  const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.DUPLICATE_MODEL_HASH_BLOCK);
  const message = logMessageFor(decision, enabled ? 'blocked' : 'would-block');
  logDecision('publish', message, match, decision, { ownerId, ...scope, flagEnabled: enabled });
  if (decision.action !== 'block' || !enabled) return;

  throw throwBadRequestError(duplicateHashMessage(match));
}
