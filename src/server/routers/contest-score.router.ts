import {
  createContestSnapshotSchema,
  getCommunityScoreSchema,
  getContestCandidatesSchema,
  listContestSnapshotsSchema,
} from '~/server/schema/contest-score.schema';
import {
  createContestSnapshot,
  getCommunityScore,
  getContestCandidates,
  listContestSnapshots,
} from '~/server/services/contest-score.service';
import { moderatorProcedure, router } from '~/server/trpc';

// Moderators only. Collection MANAGE is deliberately NOT accepted: every collection
// OWNER holds it, so honouring it would let any user point the scorer at any
// collection — a weight oracle and an unbounded load path in one. The service
// additionally refuses any collection that is not `mode = Contest`.
export const contestScoreRouter = router({
  getCommunityScore: moderatorProcedure
    .input(getCommunityScoreSchema)
    .query(({ input }) => getCommunityScore(input)),
  getCandidates: moderatorProcedure
    .input(getContestCandidatesSchema)
    .query(({ input }) => getContestCandidates(input)),
  snapshot: moderatorProcedure
    .input(createContestSnapshotSchema)
    .mutation(({ input, ctx }) =>
      createContestSnapshot({ input, userId: ctx.user.id, username: ctx.user.username })
    ),
  listSnapshots: moderatorProcedure
    .input(listContestSnapshotsSchema)
    .query(({ input }) => listContestSnapshots(input)),
});
