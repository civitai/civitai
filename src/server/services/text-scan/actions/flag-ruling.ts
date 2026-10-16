import { dbWrite } from '~/server/db/client';
import {
  confirmMinorHashAutoFlag,
  revertMinorHashAutoFlag,
} from '~/server/services/minor-hash.service';
import { MINOR_FLAG_SNAPSHOT_KEY, setModelMinor } from '~/server/services/model.service';
import { settleFlagAppealsAfterModeratorLift } from '~/server/services/text-scan/actions/appeal-text-hash';
import {
  grantModelTextScanPoi,
  stampModelTextScanAppeal,
} from '~/server/services/text-scan/actions/model-poi-minor';
import {
  hasOpenModelAppeal,
  withResolutionLock,
} from '~/server/services/text-scan/actions/redetection';
import {
  readTextScanFlags,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export type FlagRulingOutcome = 'kept' | 'lifted';

/**
 * A moderator's call on a standing text-scan flag outside an appeal: keep it or lift it, recording
 * the ruling with its reason and note. Guarded on the text hash the moderator saw, and shares the
 * per-model lock with held-detection resolution so the two cannot interleave. A keep is refused
 * while the owner has an open appeal (it is ruled from Appeals); a lift settles it.
 */
export function ruleModelTextScanFlag(args: {
  modelId: number;
  label: TextScanFlagLabel;
  keep: boolean;
  /** The flagged text the moderator was shown; the ruling applies to that and nothing newer. */
  textHash: string;
  userId: number;
  reason?: string;
  note?: string;
}) {
  return withResolutionLock(args.modelId, args.label, () => rule(args));
}

async function rule({
  modelId,
  label,
  keep,
  textHash,
  userId,
  reason,
  note,
}: Parameters<typeof ruleModelTextScanFlag>[0]) {
  const model = await dbWrite.model.findUnique({ where: { id: modelId }, select: { meta: true } });
  const entry = model ? readTextScanFlags(model.meta)[label] : undefined;
  if (!model || !entry) throw throwBadRequestError(`This model has no ${label} flag to rule on.`);
  if (entry.textHash !== textHash)
    throw throwBadRequestError('The text changed since this flag. Reload and review it again.');

  if (keep && (await hasOpenModelAppeal(modelId)))
    throw throwBadRequestError("Rule the owner's open appeal from Appeals instead.");

  if (keep) {
    if (label === 'minor') {
      const { hadVerdict, stamped } = await confirmMinorHashAutoFlag({
        modelId,
        userId,
        reason,
        note,
      });
      if (hadVerdict && !stamped)
        throw throwBadRequestError('The ruling could not be recorded. Try again.');
    } else
      await stampModelTextScanAppeal({
        modelId,
        userId,
        decision: 'appealUpheld',
        labels: ['poi'],
        via: 'moderator',
        reason,
        note,
      });
    return { ruled: 'kept' as const, label, modelId };
  }

  if (label === 'minor') {
    const meta = model.meta as Record<string, unknown> | null;
    if (meta?.[MINOR_FLAG_SNAPSHOT_KEY])
      await revertMinorHashAutoFlag({
        modelId,
        userId,
        recordTextScanRuling: true,
        reason,
        note,
        textHash,
      });
    else
      await setModelMinor({
        id: modelId,
        minor: false,
        userId,
        isModerator: true,
        recordTextScanRuling: true,
        reason,
        note,
        textHash,
      });
  } else {
    await grantModelTextScanPoi({
      modelId,
      userId,
      grantHash: textHash,
      via: 'moderator',
      reason,
      note,
    });
    await settleFlagAppealsAfterModeratorLift({
      modelId,
      userId,
      liftedLabels: ['poi'],
      recordRulings: false,
    });
  }
  return { ruled: 'lifted' as const, label, modelId };
}
