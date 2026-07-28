import {
  createContestSnapshotSchema,
  getCommunityScoreSchema,
  getContestCandidatesSchema,
  listContestSnapshotsSchema,
} from '~/server/schema/contest-score.schema';
import {
  assertCanScoreContest,
  createContestSnapshot,
  getCommunityScore,
  getContestCandidates,
  listContestSnapshots,
} from '~/server/services/contest-score.service';
import { protectedProcedure, router } from '~/server/trpc';
import { throwBadRequestError } from '~/server/utils/errorHandling';

// Runs ahead of input validation, so the collectionId is still raw here.
const isCollectionManager = protectedProcedure.use(async ({ ctx, next, getRawInput }) => {
  const { collectionId } = ((await getRawInput()) ?? {}) as { collectionId?: unknown };
  if (typeof collectionId !== 'number' || !Number.isInteger(collectionId) || collectionId <= 0)
    throw throwBadRequestError('A valid collectionId is required');

  await assertCanScoreContest({
    collectionId,
    userId: ctx.user.id,
    isModerator: ctx.user.isModerator,
  });
  return next();
});

export const contestScoreRouter = router({
  getCommunityScore: isCollectionManager
    .input(getCommunityScoreSchema)
    .query(({ input }) => getCommunityScore(input)),
  getCandidates: isCollectionManager
    .input(getContestCandidatesSchema)
    .query(({ input }) => getContestCandidates(input)),
  snapshot: isCollectionManager
    .input(createContestSnapshotSchema)
    .mutation(({ input, ctx }) =>
      createContestSnapshot({ input, userId: ctx.user.id, username: ctx.user.username })
    ),
  listSnapshots: isCollectionManager
    .input(listContestSnapshotsSchema)
    .query(({ input }) => listContestSnapshots(input)),
});
