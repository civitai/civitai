import { toggleReactionHandler } from './../controllers/reaction.controller';
import { toggleReactionSchema } from './../schema/reaction.schema';
import { router, protectedProcedure } from '~/server/trpc';

export const reactionRouter = router({
  toggle: protectedProcedure.input(toggleReactionSchema).mutation(toggleReactionHandler),
});
