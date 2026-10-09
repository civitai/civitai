import type { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { Tracker } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS,
  scamMuteIneligibility,
} from '~/server/services/scam-auto-mute.constants';
import {
  appendScamTrigger,
  closeScamCasesOpenedBefore,
  lastModeratorUnmuteAt,
  recordScamCleanup,
  linkScamStrike,
  restoreScamCases,
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
  announcePendingReviewMute,
  claimPendingReviewMute,
} from '~/server/services/user-restriction.service';
import { createStrike } from '~/server/services/strike.service';
import { strikeReasonPublicLabel } from '~/server/schema/strike.schema';
import { PROTECTED_USER_IDS } from '~/server/utils/protected-user-ids';
import { StrikeReason } from '~/shared/utils/prisma/enums';
import {
  SCAM_STRIKE_EXPIRES_IN_DAYS,
  SCAM_STRIKE_POINTS,
} from '~/shared/constants/strike.constants';

export { SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS };

const SYSTEM_ACTOR_ID = constants.system.user.id;
const MAX_REASON_CHARS = 300;
const MAX_INTERNAL_NOTES_CHARS = 2000;

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
  | 'muted';

export type ScamAutoMuteResult =
  | {
      muted: true;
      userRestrictionId: number;
      deduped: boolean;
      accountAgeDays: number;
      strikeId: number | null;
      cleanup: ScamCleanupRecord | null;
    }
  | { muted: false; skipped: ScamAutoMuteSkip };

type Slot = { userRestrictionId: number; index: number };

type Decision =
  | { kind: 'skip'; skipped: ScamAutoMuteSkip; closed: number[] }
  | {
      kind: 'case';
      slot: Slot;
      claim: Extract<Awaited<ReturnType<typeof claimPendingReviewMute>>, { muted: true }>;
      accountAgeDays: number;
      closed: number[];
    };

const skip = (skipped: ScamAutoMuteSkip): ScamAutoMuteResult => ({ muted: false, skipped });

async function logError(
  message: string,
  userId: number,
  source: string,
  error: unknown,
  userRestrictionId?: number
) {
  await logToAxiom({
    name: 'scam-auto-mute',
    type: 'error',
    message,
    userId,
    source,
    userRestrictionId,
    error: (error as Error)?.message ?? String(error),
  }).catch(() => undefined);
}

async function predatesUnmute(
  tx: Prisma.TransactionClient,
  userId: number,
  evidence: ScamEvidence,
  unmutedAt: Date
) {
  if (evidence.contentAt) return evidence.contentAt <= unmutedAt;
  if (!evidence.entityType || evidence.entityId === undefined || !evidence.textHash) return false;
  return scamTextSeenBefore(
    userId,
    { entityType: evidence.entityType, entityId: evidence.entityId, textHash: evidence.textHash },
    unmutedAt,
    tx
  );
}

/**
 * Everything up to and including filing, in one transaction that holds the account row. An unmute
 * takes the same lock, so a verdict either sees that unmute or files before it and is closed by it.
 */
async function decide(
  tx: Prisma.TransactionClient,
  userId: number,
  evidence: ScamEvidence,
  ignoreAccountAge: boolean
): Promise<Decision> {
  await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      createdAt: true,
      isModerator: true,
      muted: true,
      bannedAt: true,
      deletedAt: true,
    },
  });
  if (!user) return { kind: 'skip', skipped: 'not-found', closed: [] };
  const ineligible = scamMuteIneligibility(user, { ignoreAccountAge });
  if (ineligible) return { kind: 'skip', skipped: ineligible, closed: [] };
  if (user.muted) return { kind: 'skip', skipped: 'muted', closed: [] };

  if (await scamVerdictActioned(userId, evidence.dedupeKey, tx))
    return { kind: 'skip', skipped: 'duplicate', closed: [] };

  let closed: number[] = [];
  const unmutedAt = await lastModeratorUnmuteAt(userId, tx);
  if (unmutedAt) {
    if (await predatesUnmute(tx, userId, evidence, unmutedAt))
      return { kind: 'skip', skipped: 'unmuted-since', closed };
    closed = await closeScamCasesOpenedBefore(userId, unmutedAt, tx);
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

  const claim = await claimPendingReviewMute(tx, { userId, triggers: [entry], type: 'scam' });
  if (!claim.muted) return { kind: 'skip', skipped: claim.skipped, closed };
  const index = claim.deduped ? await appendScamTrigger(claim.userRestrictionId, entry, tx) : 0;
  if (index === null) return { kind: 'skip', skipped: 'duplicate', closed };
  return {
    kind: 'case',
    slot: { userRestrictionId: claim.userRestrictionId, index },
    claim,
    accountAgeDays: dayjs().diff(dayjs(user.createdAt), 'day'),
    closed,
  };
}

async function decideWithRetry(userId: number, evidence: ScamEvidence, ignoreAccountAge: boolean) {
  const attempt = () =>
    dbWrite.$transaction((tx) => decide(tx, userId, evidence, ignoreAccountAge));
  // Two verdicts racing for one account both pass the checks; the one-open-case index stops the
  // second, and the retry sees the account muted and skips.
  return attempt().catch((error) => {
    if ((error as { code?: unknown })?.code !== 'P2002') throw error;
    return attempt();
  });
}

async function cleanUpAndRecord(
  cleanup: ScamCleanup,
  userId: number,
  evidence: ScamEvidence,
  slot: Slot
) {
  let record: ScamCleanupRecord | null;
  try {
    record = await runScamCleanup(cleanup, userId);
  } catch (error) {
    await logError('cleanup failed', userId, evidence.source, error, slot.userRestrictionId);
    return null;
  }
  if (record)
    await recordScamCleanup(slot.userRestrictionId, slot.index, evidence.dedupeKey, record).catch(
      (error) =>
        logError('cleanup record failed', userId, evidence.source, error, slot.userRestrictionId)
    );
  return record;
}

async function audit(userId: number, slot: Slot, source: string) {
  await trackModActivity(SYSTEM_ACTOR_ID, {
    entityType: 'user',
    entityId: userId,
    activity: 'autoMuteScam',
  }).catch((error) => logError('audit failed', userId, source, error, slot.userRestrictionId));
}

/**
 * `null` when no live strike resulted; the case stands either way. The strike is linked to its case
 * as soon as the row exists, so a later failure cannot leave it out of reach of an overturn. A case
 * overturned before that link voids the strike at once; escalation then counts nothing for it.
 */
async function issueScamStrike(userId: number, evidence: ScamEvidence, slot: Slot) {
  let landed: number | null = null;
  let voided = false;
  try {
    const strike = await createStrike({
      userId,
      reason: StrikeReason.Scam,
      points: SCAM_STRIKE_POINTS,
      description: strikeReasonPublicLabel[StrikeReason.Scam],
      internalNotes:
        `Scam case ${slot.userRestrictionId} (${evidence.source}): ${evidence.reason}`.slice(
          0,
          MAX_INTERNAL_NOTES_CHARS
        ),
      expiresInDays: SCAM_STRIKE_EXPIRES_IN_DAYS,
      notifyUser: false,
      onCreated: async ({ id }) => {
        landed = id;
        voided = await linkScamStrike(
          slot.userRestrictionId,
          slot.index,
          evidence.dedupeKey,
          id
        ).catch(async (error) => {
          await logError(
            'strike record failed',
            userId,
            evidence.source,
            error,
            slot.userRestrictionId
          );
          return false;
        });
      },
    });
    if (strike && voided) {
      await logToAxiom({
        name: 'scam-auto-mute',
        type: 'info',
        message: 'strike voided: its case was overturned before the strike landed',
        userId,
        source: evidence.source,
        userRestrictionId: slot.userRestrictionId,
        strikeId: strike.id,
      }).catch(() => undefined);
      return null;
    }
    return strike?.id ?? null;
  } catch (error) {
    await logError(
      landed ? 'strike issued, but escalation failed' : 'strike failed',
      userId,
      evidence.source,
      error,
      slot.userRestrictionId
    );
    return landed;
  }
}

/**
 * Throws when it fails before the case is filed, so the caller's delivery can be retried.
 * After filing nothing throws: the remaining steps log with the case id instead.
 */
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

  const decision = await decideWithRetry(userId, evidence, ignoreAccountAge);
  await restoreScamCases(userId, decision.closed);

  if (decision.kind === 'skip') return skip(decision.skipped);

  const { claim, slot, accountAgeDays } = decision;
  if (!claim.deduped) await audit(userId, slot, evidence.source);
  await announcePendingReviewMute({ userId, type: 'scam', updateSource: 'scamAutoMute', claim });
  const strikeId = claim.deduped ? null : await issueScamStrike(userId, evidence, slot);

  const record = await cleanUpAndRecord(cleanup, userId, evidence, slot);

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
      .catch((error) =>
        logError('clickhouse failed', userId, evidence.source, error, slot.userRestrictionId)
      );

  return {
    muted: true,
    userRestrictionId: slot.userRestrictionId,
    deduped: claim.deduped,
    accountAgeDays,
    strikeId,
    cleanup: record,
  };
}
