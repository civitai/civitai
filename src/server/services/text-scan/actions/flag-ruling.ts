import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  confirmMinorHashAutoFlag,
  minorRevertRefusal,
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
  hasOpenTextScanFlag,
  readTextScanFlags,
  type TextScanFlagLabel,
} from '~/server/services/text-scan/flag-snapshot';
import { throwBadRequestError } from '~/server/utils/errorHandling';

const FLAG_CHANGED = 'The flag changed while you were ruling. Reload and review it again.';

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
  const model = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { meta: true, minor: true, poi: true },
  });
  const entry = model ? readTextScanFlags(model.meta)[label] : undefined;
  if (!model || !entry)
    throw throwBadRequestError(
      `No text-scan ${label} flag on this model; hash flags are confirmed or reverted from the queue.`
    );
  // A lifted flag keeps its entry and hash, and a stale snapshot outlives the lift: only a flag that
  // is still standing on the model can be ruled.
  if (!hasOpenTextScanFlag(model.meta, label) || !model[label])
    throw throwBadRequestError('This flag is no longer in force. Reload and review it again.');
  if (entry.textHash !== textHash)
    throw throwBadRequestError('The text changed since this flag. Reload and review it again.');
  if (entry.redetected && entry.redetected.textHash !== textHash)
    throw throwBadRequestError(
      'Newer text is held for review on this flag. Rule it from the re-detection queue.'
    );

  // Races the owner's appeal being resolved (resolveMinorFlagAppeal takes no lock shared with this).
  if (keep && (await hasOpenModelAppeal(modelId)))
    throw throwBadRequestError("Rule the owner's open appeal from Appeals instead.");

  // Minor: the flag is changed before the ruling is recorded, and a keep stamps before it signs off,
  // so a refused or failed step never leaves a ruling that contradicts the flag's state.
  if (keep) {
    const stamped = await stampModelTextScanAppeal({
      modelId,
      userId,
      decision: 'appealUpheld',
      labels: [label],
      via: 'moderator',
      reason,
      note,
      expectTextHash: textHash,
    });
    if (!stamped) throw throwBadRequestError(FLAG_CHANGED);
    if (label === 'minor')
      await confirmMinorHashAutoFlag({ modelId, userId, recordTextScanRuling: false });
    return { ruled: 'kept' as const, label, modelId };
  }

  if (label === 'minor') {
    // The ruling undoes the automation and is recorded on the text. Minor stays, and the result says
    // so, when it was minor before the automation or a moderator set or confirmed it.
    let keptMinor = false;
    const meta = model.meta as Record<string, unknown> | null;
    if (meta?.[MINOR_FLAG_SNAPSHOT_KEY] && (await minorRevertRefusal(modelId))) keptMinor = true;
    else if (meta?.[MINOR_FLAG_SNAPSHOT_KEY]) {
      const report = await revertMinorHashAutoFlag({
        modelId,
        userId,
        recordTextScanRuling: false,
      });
      keptMinor = report.keptMinor === 1;
      if (report.rolledBack !== 1 && !keptMinor)
        throw throwBadRequestError('The flag could not be lifted. Reload and try again.');
    } else
      await setModelMinor({
        id: modelId,
        minor: false,
        userId,
        isModerator: true,
        recordTextScanRuling: false,
      });
    // A failed record leaves the lift in place and the appeal open: the flag state is the safer one.
    const stamped = await stampModelTextScanAppeal({
      modelId,
      userId,
      decision: 'appealGranted',
      labels: ['minor'],
      grantHashes: { minor: textHash },
      via: 'moderator',
      reason,
      note,
      expectTextHash: textHash,
    });
    if (!stamped) {
      logToAxiom({
        type: 'error',
        name: 'text-scan',
        message: 'minor flag lifted but the moderator ruling was not recorded',
        modelId,
      }).catch(() => null);
      throw throwBadRequestError(
        'The flag was lifted but the ruling was not recorded: the text changed meanwhile. Reload to review it.'
      );
    }
    await settleFlagAppealsAfterModeratorLift({
      modelId,
      userId,
      liftedLabels: ['minor'],
      recordRulings: false,
    });
    if (keptMinor) return { ruled: 'keptMinor' as const, label, modelId };
  } else {
    const granted = await grantModelTextScanPoi({
      modelId,
      userId,
      grantHash: textHash,
      via: 'moderator',
      reason,
      note,
      expectTextHash: textHash,
    });
    if (!granted) throw throwBadRequestError(FLAG_CHANGED);
    await settleFlagAppealsAfterModeratorLift({
      modelId,
      userId,
      liftedLabels: ['poi'],
      recordRulings: false,
    });
  }
  return { ruled: 'lifted' as const, label, modelId };
}
