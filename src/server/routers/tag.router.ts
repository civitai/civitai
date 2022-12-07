import { getTagWithModelCountHandler } from './../controllers/tag.controller';
import { getTagByNameSchema } from './../schema/tag.schema';
import { getAllTagsHandler } from '~/server/controllers/tag.controller';
import { getTagsInput } from '~/server/schema/tag.schema';
import { publicProcedure, router } from '~/server/trpc';

export const tagRouter = router({
  getTagWithModelCount: publicProcedure
    .input(getTagByNameSchema)
    .query(getTagWithModelCountHandler),
  getAll: publicProcedure.input(getTagsInput.optional()).query(getAllTagsHandler),
});
