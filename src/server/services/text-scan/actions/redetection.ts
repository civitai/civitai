import { dbWrite } from '~/server/db/client';
import { randomUUID } from 'node:crypto';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
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
  readTextScanFlags,
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

const LOCK_SECONDS = 120;
const RELEASE_IF_HELD =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";
const lockKey = (modelId: number, label: TextScanFlagLabel) =>
  `${REDIS_SYS_KEYS.TEXT_SCAN.REDETECTION_LOCK}:${modelId}:${label}` as const;

// A keep runs for seconds across several writes, and the queue keeps listing the row meanwhile.
// One resolution per model and label at a time; the lock expires on its own if the process dies.
// A Redis outage lets the request through: the hash guards still refuse a conflicting ruling.
async function withResolutionLock<T>(
  modelId: number,
  label: TextScanFlagLabel,
  run: () => Promise<T>
): Promise<T> {
  const key = lockKey(modelId, label);
  // Per request, so a slow request whose lock expired cannot free the one a newer request now holds.
  const token = randomUUID();
  const acquired = await sysRedis
    .set(key, token, { NX: true, EX: LOCK_SECONDS })
    .then((reply) => !!reply)
    .catch(() => true);
  if (!acquired)
    throw throwBadRequestError('This re-detection is being resolved. Reload the queue.');
  try {
    return await run();
  } finally {
    await sysRedis.eval(RELEASE_IF_HELD, { keys: [key], arguments: [token] }).catch(() => null);
  }
}

/**
 * A moderator's call on a label the scan re-detected after a human had cleared it. Keeping applies
 * the flag exactly as the scan would have (restrictions, snapshot, owner notice) and records the
 * moderator's upheld ruling; dismissing stamps a fresh clear on the re-detected text and tells no one.
 * An appeal the owner still has open is resolved by its own flow, not here.
 */
export function resolveTextScanRedetection(args: {
  modelId: number;
  label: TextScanFlagLabel;
  keep: boolean;
  /** The re-detected text the moderator was shown; the ruling applies to that and nothing newer. */
  textHash: string;
  userId: number;
}): Promise<RedetectionOutcome> {
  return withResolutionLock(args.modelId, args.label, () => resolve(args));
}

async function resolve({
  modelId,
  label,
  keep,
  textHash,
  userId,
}: {
  modelId: number;
  label: TextScanFlagLabel;
  keep: boolean;
  textHash: string;
  userId: number;
}): Promise<RedetectionOutcome> {
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { meta: true, minor: true, poi: true },
  });
  const detection = model ? getTextScanRedetection(model.meta, label) : null;
  if (!model || !detection || detection.textHash !== textHash) throw stale();

  // Any label: the owner's appeal covers the model, and the queue disables its buttons on the same
  // rule (`hasPendingAppeal` in the moderator app's getRedetectedModels).
  const openAppeal = await dbWrite.appeal.findFirst({
    where: { entityType: EntityType.Model, entityId: modelId, status: AppealStatus.Pending },
    select: { id: true },
  });
  if (openAppeal) throw throwBadRequestError("Resolve the owner's open appeal first.");

  // The label entry was written by a keep of this very detection that did not finish, as opposed to
  // a flag from another route.
  const entry = readTextScanFlags(model.meta)[label];
  const ownEntry =
    !!entry?.workflowId && entry.workflowId === detection.workflowId && entry.textHash === textHash;

  if (!keep) {
    if (ownEntry)
      throw throwBadRequestError('A keep of this flag is unfinished. Retry Keep to complete it.');
    if (model[label]) {
      if (!(await dropRedetection({ modelId, label, textHash }))) throw stale();
      return 'closed';
    }
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
  if (model[label] && !ownEntry) {
    if (!(await dropRedetection({ modelId, label, textHash }))) throw stale();
    return 'closed';
  }

  const flag = {
    modelId,
    workflowId: detection.workflowId,
    reason: detection.reason ?? '',
    textHash,
    kept: { userId, resume: model[label] && ownEntry },
  };
  const { written } =
    label === 'poi'
      ? await flagModelPoi({ ...flag, names: detection.names ?? [] })
      : await flagModelMinor(flag);
  if (!written) throw stale();

  // Once per keep: a resumed keep may already have recorded it, and re-stamping would push the first
  // into the history.
  if (!(ownEntry && entry?.appealUpheld?.textHash === textHash))
    await stampModelTextScanAppeal({
      modelId,
      userId,
      decision: 'appealUpheld',
      labels: [label],
      via: 'moderator',
    });
  // Last, so a failure anywhere above leaves the item in the queue to retry.
  await dropRedetection({ modelId, label, textHash });
  return 'kept';
}
