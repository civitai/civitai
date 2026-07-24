import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { getChallengeExcludedUserIds } from '~/server/services/challenge-block.service';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

const NOTIFY = 'Notify' as const;

// Tracking is only meaningful while a challenge still has something ahead of it. Untracking stays
// open at any status so a user can always clear a stale subscription.
const TRACKABLE_STATUSES: ChallengeStatus[] = [ChallengeStatus.Scheduled, ChallengeStatus.Active];

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function toggleChallengeNotify({
  challengeId,
  userId,
  setTo,
}: {
  challengeId: number;
  userId: number;
  setTo?: boolean;
}): Promise<boolean> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { id: true, status: true, createdById: true },
  });
  if (!challenge) throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });

  const excluded = await getChallengeExcludedUserIds(userId);
  if (challenge.createdById && excluded.includes(challenge.createdById))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Challenge not found' });

  const existing = await dbRead.challengeEngagement.findUnique({
    where: { type_challengeId_userId: { type: NOTIFY, challengeId, userId } },
    select: { type: true },
  });

  const next = setTo ?? !existing;

  if (next && !TRACKABLE_STATUSES.includes(challenge.status))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This challenge is no longer open' });

  if (next) {
    if (existing) return true;
    try {
      await dbWrite.challengeEngagement.create({
        data: { type: NOTIFY, challengeId, userId },
      });
    } catch (error) {
      // Two concurrent toggles both read "absent" and both create; the loser's row already exists,
      // so the intended end state holds — resolve to success instead of a 500.
      if (!isUniqueViolation(error)) throw error;
    }
    return true;
  }

  if (existing) {
    await dbWrite.challengeEngagement.delete({
      where: { type_challengeId_userId: { type: NOTIFY, challengeId, userId } },
    });
  }
  return false;
}

export async function getChallengeNotifyRecipients(challengeId: number): Promise<number[]> {
  const rows = await dbRead.challengeEngagement.findMany({
    where: { challengeId, type: NOTIFY },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

export async function getChallengeReminderRecipients(challengeId: number): Promise<number[]> {
  const challenge = await dbRead.challenge.findUnique({
    where: { id: challengeId },
    select: { collectionId: true },
  });

  const trackers = await getChallengeNotifyRecipients(challengeId);
  if (!challenge?.collectionId) return trackers;

  const entrants = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT DISTINCT ci."addedById" AS "userId"
    FROM "CollectionItem" ci
    WHERE ci."collectionId" = ${challenge.collectionId}
      AND ci."addedById" IS NOT NULL
  `;

  return [...new Set([...trackers, ...entrants.map((e) => e.userId)])];
}

export async function getTrackedChallengeIds(userId: number): Promise<number[]> {
  const rows = await dbRead.challengeEngagement.findMany({
    where: {
      userId,
      type: NOTIFY,
      challenge: { status: { in: TRACKABLE_STATUSES } },
    },
    select: { challengeId: true },
  });
  return rows.map((r) => r.challengeId);
}
