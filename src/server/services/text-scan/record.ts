import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import type { StoredTextScanVerdict } from '~/server/services/text-scan/merge';
import type { PromptIds, TextScanOutcome, TextScanOutput } from '~/server/services/text-scan/types';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

export type TextScanResult = {
  version: 1;
  labels: TextScanOutput;
  promptIds: PromptIds;
  model: string;
  /** `textScanTextHash` of the subject as submitted. */
  textHash?: string;
  meta?: Record<string, unknown>;
};

type RowKey = { entityType: string; entityId: number };

export async function markTextScanPending({
  entityType,
  entityId,
  marker,
  contentHash,
}: RowKey & { marker: string; contentHash: string }) {
  // The previous verdict stays until the new callback lands; clearing it here would let
  // an edit drop a rating floor for the length of the scan, or for good if it fails.
  await dbWrite.entityModeration.upsert({
    where: { entityType_entityId: { entityType, entityId } },
    create: {
      entityType,
      entityId,
      workflowId: marker,
      contentHash,
      status: EntityModerationStatus.Pending,
    },
    update: { workflowId: marker, contentHash, status: EntityModerationStatus.Pending },
  });
}

export async function bindTextScanWorkflowId({
  entityType,
  entityId,
  marker,
  workflowId,
}: RowKey & { marker: string; workflowId: string }) {
  await dbWrite.entityModeration.updateMany({
    where: { entityType, entityId, workflowId: marker },
    data: { workflowId },
  });
}

export async function markTextScanSubmitFailed({
  entityType,
  entityId,
  marker,
}: RowKey & { marker: string }) {
  await dbWrite.entityModeration.updateMany({
    where: { entityType, entityId, workflowId: marker },
    data: { workflowId: null, status: EntityModerationStatus.Failed, retryCount: { increment: 1 } },
  });
}

// Until the submit returns, the row holds the externalId instead of the workflow id.
function matchWorkflow(workflowId: string, marker?: string) {
  return marker ? { in: [workflowId, marker] } : workflowId;
}

export async function recordTextScanSuccess({
  entityType,
  entityId,
  workflowId,
  marker,
  outcome,
  output,
  promptIds,
  model,
  textHash,
  meta,
}: RowKey & {
  workflowId: string;
  marker?: string;
  outcome: TextScanOutcome;
  output: TextScanOutput;
  promptIds: PromptIds;
  model: string;
  textHash?: string;
  meta?: Record<string, unknown>;
}) {
  const result: TextScanResult = { version: 1, labels: output, promptIds, model, textHash, meta };
  const updated = await dbWrite.entityModeration.updateMany({
    where: { entityType, entityId, workflowId: matchWorkflow(workflowId, marker) },
    data: {
      workflowId,
      status: EntityModerationStatus.Succeeded,
      blocked: false,
      triggeredLabels: outcome.triggeredLabels,
      nsfwLevel: outcome.nsfwLevel,
      result: result as unknown as Prisma.InputJsonValue,
    },
  });
  return updated.count > 0;
}

export async function recordTextScanFailure({
  entityType,
  entityId,
  workflowId,
  marker,
  status,
}: RowKey & {
  workflowId: string;
  marker?: string;
  status: Exclude<EntityModerationStatus, 'Pending' | 'Succeeded'>;
}) {
  const updated = await dbWrite.entityModeration.updateMany({
    where: { entityType, entityId, workflowId: matchWorkflow(workflowId, marker) },
    data: { workflowId, status, retryCount: { increment: 1 } },
  });
  return updated.count > 0;
}

type StoredRow = StoredTextScanVerdict & { result: TextScanResult | null };

/** The row's current verdict, or null when `workflowId` no longer owns it. */
export async function readTextScanVerdict({
  entityType,
  entityId,
  workflowId,
}: RowKey & { workflowId: string }): Promise<StoredRow | null> {
  const row = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { workflowId: true, nsfwLevel: true, triggeredLabels: true, result: true },
  });
  if (!row || row.workflowId !== workflowId) return null;
  const result = row.result as TextScanResult | null;
  const isTextScan = result?.version != null;
  return {
    nsfwLevel: row.nsfwLevel,
    triggeredLabels: row.triggeredLabels,
    labels: isTextScan ? result.labels : undefined,
    result: isTextScan ? result : null,
  };
}

/**
 * Raises a Failed row's verdict to `outcome` for the labels in `output` alone, leaving it Failed
 * for the retry job. The caller passes only labels stricter than `stored`, so nothing is lowered.
 */
export async function recordTextScanRaise({
  entityType,
  entityId,
  workflowId,
  stored,
  outcome,
  output,
  promptIds,
  model,
  textHash,
  meta,
}: RowKey & {
  workflowId: string;
  stored: StoredRow;
  outcome: TextScanOutcome;
  output: TextScanOutput;
  promptIds: PromptIds;
  model: string;
  textHash?: string;
  meta?: Record<string, unknown>;
}) {
  const result: TextScanResult = stored.result
    ? { ...stored.result, labels: { ...stored.result.labels, ...output } }
    : { version: 1, labels: output, promptIds, model, textHash, meta };
  const updated = await dbWrite.entityModeration.updateMany({
    where: { entityType, entityId, workflowId, status: EntityModerationStatus.Failed },
    data: {
      triggeredLabels: [...new Set([...stored.triggeredLabels, ...outcome.triggeredLabels])],
      nsfwLevel: Math.max(stored.nsfwLevel ?? 0, outcome.nsfwLevel ?? 0) || stored.nsfwLevel,
      result: result as unknown as Prisma.InputJsonValue,
    },
  });
  return updated.count > 0;
}
