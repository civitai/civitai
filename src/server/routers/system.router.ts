import { publicProcedure, router } from '~/server/trpc';
import { getModerationTags } from '~/server/services/system-cache';

export const systemRouter = router({
  getModeratedTags: publicProcedure.query(() => getModerationTags()),
});
