import { getAllDailyChallenges } from '~/server/services/daily-challenge.service';
import { publicProcedure, router } from '~/server/trpc';

export const dailyChallengeRouter = router({
  getAll: publicProcedure.query(() => getAllDailyChallenges()),
});
