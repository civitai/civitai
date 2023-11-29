import { toggleReactionHandler } from './../controllers/reaction.controller';
import { toggleReactionSchema } from './../schema/reaction.schema';
import { router, guardedProcedure } from '~/server/trpc';

export const reactionRouter = router({
  toggle: guardedProcedure.input(toggleReactionSchema).mutation(toggleReactionHandler),
});
