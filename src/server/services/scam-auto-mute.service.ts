import dayjs from '~/shared/utils/dayjs';
import { Tracker } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import { SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS } from '~/server/services/scam-auto-mute.constants';
import {
  appendScamTrigger,
  closeScamCasesOpenedBefore,
  fileScamCleanupRecord,
  lastModeratorUnmuteAt,
  recordScamCleanup,
  scamTextSeenBefore,
  scamVerdictActioned,
  type ScamTriggerEntry,
} from '~/server/services/scam-case-ledger';
import {
  runScamCleanup,
  type ScamCleanup,
  type ScamCleanupRecord,
} from '~/server/services/scam-cleanup.service';
import {
  applyPendingReviewMute,
  PROTECTED_USER_IDS,
} from '~/server/services/user-restriction.service';

export { SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS };

const SYSTEM_ACTOR_ID = -1;
const MAX_REASON_CHARS = 300;

export type ScamEvidence = {
  /** `text-scan:<EntityType>:<id>` or `clavata:<type>` */
  source: string;
  /** The workflow id, or `clavata:<type>:<entityId>:<tags>` */
  dedupeKey: string;
  reason: string;
  entityType?: string;
  entityId?: number;
  text?: string;
  textHash?: string;
  contentAt?: Date | null;
};

export type ScamAutoMuteSkip =
  | 'invalid-user'
  | 'protected'
  | 'not-found'
  | 'moderator'
  | 'deleted'
  | 'banned'
  | 'too-old'
  | 'duplicate'
  | 'unmuted-since'
  | 'moderator-muted'
  | 'error';

export type ScamAutoMuteResult =
  | {
      muted: true;
      userRestrictionId: number;
      deduped: boolean;
      accountAgeDays: number;
      cleanup: ScamCleanupRecord | null;
    }
  | { muted: false; skipped: ScamAutoMuteSkip; cleanup?: ScamCleanupRecord | null };

const skip = (skipped: ScamAutoMuteSkip): ScamAutoMuteResult => ({ muted: false, skipped });

async function logError(message: string, userId: number, source: string, error: unknown) {
  await logToAxiom({
    name: 'scam-auto-mute',
    type: 'error',
    message,
    userId,
    source,
    error: (error as Error)?.message ?? String(error),
  }).catch(() => undefined);
}

async function predatesUnmute(userId: number, evidence: ScamEvidence, unmutedAt: Date) {
  if (evidence.contentAt) return evidence.contentAt <= unmutedAt;
  if (!evidence.entityType || evidence.entityId === undefined || !evidence.textHash) return false;
  return scamTextSeenBefore(
    userId,
    { entityType: evidence.entityType, entityId: evidence.entityId, textHash: evidence.textHash },
    unmutedAt
  );
}

async function fileScamCase(userId: number, entry: ScamTriggerEntry) {
  const file = () =>
    applyPendingReviewMute({
      userId,
      triggers: [entry],
      updateSource: 'scamAutoMute',
      type: 'scam',
    });
  // The loser of two concurrent first verdicts hits the one-open-case index; the retry dedupes.
  const result = await file().catch((error) => {
    if ((error as { code?: unknown })?.code !== 'P2002') throw error;
    return file();
  });
  if (!result.muted) return result;
  if (!result.deduped) return { ...result, index: 0 };
  const index = await appendScamTrigger(result.userRestrictionId, entry);
  return index === null ? null : { ...result, index };
}

async function cleanUp(cleanup: ScamCleanup, userId: number, source: string) {
  try {
    return await runScamCleanup(cleanup, userId);
  } catch (error) {
    await logError('cleanup failed', userId, source, error);
    return null;
  }
}

async function cleanUpAndRecord(
  cleanup: ScamCleanup,
  userId: number,
  evidence: ScamEvidence,
  slot: { userRestrictionId: number; index: number }
) {
  const record = await cleanUp(cleanup, userId, evidence.source);
  if (record)
    await recordScamCleanup(slot.userRestrictionId, slot.index, evidence.dedupeKey, record).catch(
      (error) => logError('cleanup record failed', userId, evidence.source, error)
    );
  return record;
}

export async function autoMuteScamAccount({
  userId,
  evidence,
  cleanup,
  ignoreAccountAge = false,
}: {
  userId: number;
  evidence: ScamEvidence;
  cleanup: ScamCleanup;
  ignoreAccountAge?: boolean;
}): Promise<ScamAutoMuteResult> {
  if (!(userId > 0)) return skip('invalid-user');
  if (PROTECTED_USER_IDS.has(userId)) return skip('protected');

  try {
    const user = await dbWrite.user.findUnique({
      where: { id: userId },
      select: {
        createdAt: true,
        isModerator: true,
        muted: true,
        mutedAt: true,
        bannedAt: true,
        deletedAt: true,
      },
    });
    if (!user) return skip('not-found');
    if (user.isModerator) return skip('moderator');
    if (user.deletedAt) return skip('deleted');
    if (user.bannedAt) return skip('banned');

    const accountAgeDays = dayjs().diff(dayjs(user.createdAt), 'day');
    if (!ignoreAccountAge && accountAgeDays > SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS)
      return skip('too-old');

    if (await scamVerdictActioned(userId, evidence.dedupeKey)) return skip('duplicate');

    const unmutedAt = await lastModeratorUnmuteAt(userId);
    if (unmutedAt) {
      if (await predatesUnmute(userId, evidence, unmutedAt)) return skip('unmuted-since');
      await closeScamCasesOpenedBefore(userId, unmutedAt);
    }

    const entry: ScamTriggerEntry = {
      category: 'scam',
      source: evidence.source,
      dedupeKey: evidence.dedupeKey,
      reason: evidence.reason,
      time: new Date().toISOString(),
      entityType: evidence.entityType,
      entityId: evidence.entityId,
      text: evidence.text,
      textHash: evidence.textHash,
      contentAt: evidence.contentAt?.toISOString() ?? null,
    };

    if (user.muted && user.mutedAt) {
      const slot = await fileScamCleanupRecord(userId, entry);
      if (!slot) return skip('duplicate');
      if (slot.created)
        await trackModActivity(SYSTEM_ACTOR_ID, {
          entityType: 'user',
          entityId: userId,
          activity: 'scamCleanup',
        });
      return {
        muted: false,
        skipped: 'moderator-muted',
        cleanup: await cleanUpAndRecord(cleanup, userId, evidence, slot),
      };
    }

    const claim = await fileScamCase(userId, entry);
    if (!claim) return skip('duplicate');
    if (!claim.muted) return skip(claim.skipped);

    if (!claim.deduped)
      await trackModActivity(SYSTEM_ACTOR_ID, {
        entityType: 'user',
        entityId: userId,
        activity: 'autoMuteScam',
      });

    const record = await cleanUpAndRecord(cleanup, userId, evidence, claim);

    if (!claim.deduped)
      await new Tracker()
        .userActivity({
          type: 'Muted',
          targetUserId: userId,
          source: `auto-mute-scam (${
            evidence.source
          }, age: ${accountAgeDays}d, ${evidence.reason.slice(0, MAX_REASON_CHARS)}, ${
            record ? `${record.kind}: ${record.count}` : 'no cleanup'
          })`,
        })
        .catch((error) => logError('clickhouse failed', userId, evidence.source, error));

    return {
      muted: true,
      userRestrictionId: claim.userRestrictionId,
      deduped: claim.deduped,
      accountAgeDays,
      cleanup: record,
    };
  } catch (error) {
    await logError('Error auto-muting user', userId, evidence.source, error);
    return skip('error');
  }
}
