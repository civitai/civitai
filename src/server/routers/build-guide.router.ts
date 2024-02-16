import { publicProcedure, router } from '~/server/trpc';
import { getBuildGuides } from '~/server/services/build-guide.services';

export const buildGuideRouter = router({
  getAll: publicProcedure.query(() => getBuildGuides()),
});
