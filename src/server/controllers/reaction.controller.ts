import { toggleReaction } from './../services/reaction.service';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';

export const toggleReactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: ToggleReactionInput;
}) => {
  try {
    await toggleReaction({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};
