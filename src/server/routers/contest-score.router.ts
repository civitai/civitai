import {
  createContestSnapshotSchema,
  getCommunityScoreSchema,
  getContestCandidatesSchema,
  getContestScoringConfigSchema,
  getContestSnapshotSchema,
  listContestSnapshotsSchema,
  runCommunityScoreSchema,
  setContestScoringConfigSchema,
} from '~/server/schema/contest-score.schema';
import {
  createContestSnapshot,
  getCommunityScore,
  getContestCandidates,
  getContestScoringConfigForEditor,
  getContestSnapshot,
  listContestSnapshots,
  runCommunityScore,
  setContestScoringConfig,
} from '~/server/services/contest-score.service';
import { moderatorProcedure, router } from '~/server/trpc';

// Moderators only. Collection MANAGE is deliberately NOT accepted: every collection
// OWNER holds it, so honouring it would let any user point the scorer at any
// collection — a weight oracle and an unbounded load path in one. The service
// additionally refuses any collection that is not `mode = Contest`.
//
// The config procedures are separate from the scoring ones and carry a separate
// payload. Scores never include weights, denominators or thresholds, so relaxing the
// gate on one of these cannot expose the other.
export const contestScoreRouter = router({
  getCommunityScore: moderatorProcedure
    .input(getCommunityScoreSchema)
    .query(({ input }) => getCommunityScore(input)),
  runCommunityScore: moderatorProcedure
    .input(runCommunityScoreSchema)
    .mutation(({ input, ctx }) => runCommunityScore({ input, userId: ctx.user.id })),
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
  getSnapshot: moderatorProcedure
    .input(getContestSnapshotSchema)
    .query(({ input }) => getContestSnapshot(input)),
  getConfig: moderatorProcedure
    .input(getContestScoringConfigSchema)
    .query(({ input }) => getContestScoringConfigForEditor(input.collectionId)),
  setConfig: moderatorProcedure
    .input(setContestScoringConfigSchema)
    .mutation(({ input, ctx }) =>
      setContestScoringConfig({ input, userId: ctx.user.id, username: ctx.user.username })
    ),
});
