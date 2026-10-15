import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  dropRedetection,
  flagModelMinor,
  flagModelPoi,
  stampModelTextScanAppeal,
} from '~/server/services/text-scan/actions/model-poi-minor';
import { carriedRulings, flagEntryPath, labelLiteral } from '~/server/services/text-scan/flag-sql';
import {
  getTextScanRedetection,
  TEXT_SCAN_FLAGS_KEY,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

export type RedetectionOutcome = 'kept' | 'dismissed' | 'closed';

// A moderator's dismissal: the clear on the re-detected text, with the grant it supersedes moved into
// the history. Guarded on the hash the moderator was shown. The grant shape matches the one
// `stampModelTextScanAppeal` writes, so the two must change together.
async function dismissRedetection({
  modelId,
  label,
  textHash,
  userId,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  textHash: string;
  userId: number;
}) {
  const entry = flagEntryPath(label);
  const dismissed = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = COALESCE(m.meta, '{}'::jsonb) || jsonb_build_object(
      ${TEXT_SCAN_FLAGS_KEY}, COALESCE(m.meta->${TEXT_SCAN_FLAGS_KEY}, '{}'::jsonb) || jsonb_build_object(
        ${labelLiteral(label)}, (${entry} - 'redetected') || ${carriedRulings(label, [
    'appealGranted',
  ])} || jsonb_build_object(
          'appealGranted', jsonb_build_object(
            'at', now(), 'by', ${userId}::int, 'textHash', ${textHash}::text, 'via', 'moderator'
          )
        )
      )
    )
    WHERE m.id = ${modelId}
      AND ${entry}->'redetected'->>'textHash' = ${textHash}
  `;
  return dismissed > 0;
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
  textHash,
  userId,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  keep: boolean;
  /** The re-detected text the moderator was shown; the ruling applies to that and nothing newer. */
  textHash: string;
  userId: number;
}): Promise<RedetectionOutcome> {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { meta: true, minor: true, poi: true },
  });
  const detection = model ? getTextScanRedetection(model.meta, label) : null;
  if (!model || !detection || detection.textHash !== textHash) throw stale();

  // The owner's appeal is decided by its own flow; ruling here would leave it open on a moved target.
  const openAppeal = await dbWrite.appeal.findFirst({
    where: { entityType: EntityType.Model, entityId: modelId, status: AppealStatus.Pending },
    select: { id: true },
  });
  if (openAppeal) throw throwBadRequestError("Resolve the owner's open appeal first.");

  if (!keep) {
    if (!(await dismissRedetection({ modelId, label, textHash, userId }))) throw stale();
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
    if (!(await dropRedetection({ modelId, label, textHash }))) throw stale();
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

  // The flag write dropped the marker once its side effects landed; the upheld ruling lands on the new entry.
  await stampModelTextScanAppeal({
    modelId,
    userId,
    decision: 'appealUpheld',
    labels: [label],
    via: 'moderator',
  });
  return 'kept';
}
