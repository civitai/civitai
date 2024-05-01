import { getAllTools } from '~/server/services/tool.service';
import { publicProcedure, router } from '~/server/trpc';

export const toolRouter = router({
  getAll: publicProcedure.query(() => getAllTools()),
});
