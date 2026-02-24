import {
  getAllDailyChallenges,
  getCurrentDailyChallenge,
} from '~/server/services/daily-challenge.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';

export const dailyChallengeRouter = router({
  getAll: publicProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(() => getAllDailyChallenges()),
  getCurrent: publicProcedure
    .use(isFlagProtected('challengePlatform'))
    .query(() => getCurrentDailyChallenge()),
});
