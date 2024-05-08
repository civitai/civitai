import { getAllTechniques } from '~/server/services/technique.service';
import { publicProcedure, router } from '~/server/trpc';

export const techniqueRouter = router({
  getAll: publicProcedure.query(() => getAllTechniques()),
});
