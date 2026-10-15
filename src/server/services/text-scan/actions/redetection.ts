import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  carriedRulings,
  flagEntryPath,
  flagModelMinor,
  flagModelPoi,
  labelLiteral,
  stampModelTextScanAppeal,
} from '~/server/services/text-scan/actions/model-poi-minor';
import {
  getTextScanRedetection,
  TEXT_SCAN_FLAGS_KEY,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export type RedetectionOutcome = 'kept' | 'dismissed' | 'closed';

// Ends a pending re-detection. A dismissal also records the moderator's clear on the text that was
// re-detected, moving the grant it supersedes into the history; closing only drops the marker.
// Guarded on the hash the moderator was shown, so a newer detection is never resolved unseen.
async function closeRedetection({
  modelId,
  label,
  textHash,
  dismissedBy,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  textHash: string;
  dismissedBy?: number;
}) {
  const entry = flagEntryPath(label);
  const next =
    dismissedBy === undefined
      ? Prisma.sql`${entry} - 'redetected'`
      : Prisma.sql`(${entry} - 'redetected') || ${carriedRulings(label)} || jsonb_build_object(
          'appealGranted', jsonb_build_object(
            'at', now(), 'by', ${dismissedBy}::int, 'textHash', ${textHash}::text, 'via', 'moderator'
          )
        )`;
  const closed = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
        ${labelLiteral(label)}, ${next}
      )
    )
    WHERE m.id = ${modelId}
      AND ${entry}->'redetected'->>'textHash' = ${textHash}
  `;
  return closed > 0;
}

const stale = () =>
  throwBadRequestError('This re-detection changed or was already resolved. Reload the queue.');

/**
 * A moderator's call on a label the scan re-detected after a human had cleared it. Keeping applies
 * the flag exactly as the scan would have (restrictions, snapshot, owner notice) and records the
 * moderator's upheld ruling; dismissing stamps a fresh clear on the re-detected text and tells no one.
 * An appeal the owner still has open is resolved by its own flow, not here.
 */
export async function resolveTextScanRedetection({
  modelId,
  label,
  keep,
  userId,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  keep: boolean;
  userId: number;
}): Promise<RedetectionOutcome> {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { meta: true, minor: true, poi: true },
  });
  const detection = model ? getTextScanRedetection(model.meta, label) : null;
  if (!model || !detection) throw stale();
  const { textHash } = detection;

  if (!keep) {
    if (!(await closeRedetection({ modelId, label, textHash, dismissedBy: userId })))
      throw stale();
    logToAxiom({
      name: 'text-scan',
      type: 'info',
      message: `${label} re-detection dismissed`,
      entityType: 'Model',
      entityId: modelId,
      moderatorId: userId,
    }).catch(() => null);
    return 'dismissed';
  }

  // Flagged by another route since: there is nothing left to apply.
  if (model[label]) {
    if (!(await closeRedetection({ modelId, label, textHash }))) throw stale();
    return 'closed';
  }

  const flag = {
    modelId,
    workflowId: detection.workflowId,
    reason: detection.reason ?? '',
    textHash,
    kept: { userId },
  };
  const { written } =
    label === 'poi'
      ? await flagModelPoi({ ...flag, names: detection.names ?? [] })
      : await flagModelMinor(flag);
  if (!written) throw stale();

  // The flag write replaced the entry and the re-detection with it; the upheld ruling lands on the new one.
  await stampModelTextScanAppeal({
    modelId,
    userId,
    decision: 'appealUpheld',
    labels: [label],
    via: 'moderator',
  });
  return 'kept';
}
