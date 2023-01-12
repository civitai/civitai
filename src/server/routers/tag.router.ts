import {
  getAllTagsHandler,
  getTagWithModelCountHandler,
  getTrendingTagsHandler,
} from '~/server/controllers/tag.controller';
import {
  getTagByNameSchema,
  getTagsInput,
  getTrendingTagsSchema,
} from '~/server/schema/tag.schema';
import { publicProcedure, router } from '~/server/trpc';

export const tagRouter = router({
  getTagWithModelCount: publicProcedure
    .input(getTagByNameSchema)
    .query(getTagWithModelCountHandler),
  getAll: publicProcedure.input(getTagsInput.optional()).query(getAllTagsHandler),
  getTrending: publicProcedure.input(getTrendingTagsSchema).query(getTrendingTagsHandler),
});
