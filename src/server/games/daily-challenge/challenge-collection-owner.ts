import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { getChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

// Challenge entry collections are owned by the judge's account, never the creator's: collection
// ownership grants unconditional `manage`, which would let a creator delete the collection,
// hand-review entries past the safety checks, or rewrite the contest metadata.
export async function resolveChallengeCollectionOwnerId(
  judgeId?: number | null
): Promise<number> {
  const resolvedJudgeId = judgeId ?? (await getChallengeConfig()).defaultJudgeId;
  if (!resolvedJudgeId)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'No challenge judge is configured.',
    });

  const judge = await dbRead.challengeJudge.findUnique({
    where: { id: resolvedJudgeId },
    select: { userId: true },
  });
  if (!judge)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `No challenge judge found for id ${resolvedJudgeId}.`,
    });

  return judge.userId;
}
