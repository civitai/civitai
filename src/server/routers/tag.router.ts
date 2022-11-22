import { getAllTagsHandler } from '~/server/controllers/tag.controller';
import { getTagsInput } from '~/server/schema/tag.schema';
import { publicProcedure, router } from '~/server/trpc';

export const tagRouter = router({
  getAll: publicProcedure.input(getTagsInput.optional()).query(getAllTagsHandler),
});
