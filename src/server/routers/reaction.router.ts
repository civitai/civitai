import {
  getUserReactionHandler,
  upsertReactionHandler,
} from './../controllers/reaction.controller';
import { upsertReactionSchema, getReactionSchema } from './../schema/reaction.schema';
import { router, protectedProcedure } from '~/server/trpc';

export const reactionRouter = router({
  getUserReaction: protectedProcedure.input(getReactionSchema).query(getUserReactionHandler),
  upsert: protectedProcedure.input(upsertReactionSchema).mutation(upsertReactionHandler),
});
