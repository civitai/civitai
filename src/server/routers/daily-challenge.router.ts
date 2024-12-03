import {
  getAllDailyChallenges,
  getCurrentDailyChallenge,
} from '~/server/services/daily-challenge.service';
import { publicProcedure, router } from '~/server/trpc';

export const dailyChallengeRouter = router({
  getAll: publicProcedure.query(() => getAllDailyChallenges()),
  getCurrent: publicProcedure.query(() => getCurrentDailyChallenge()),
});
