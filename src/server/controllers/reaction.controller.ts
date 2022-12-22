import { reactionSelect } from './../selectors/reaction.selector';
import { upsertReaction, getUserReaction } from './../services/reaction.service';
import { UpsertReactionSchema, GetReactionInput } from '~/server/schema/reaction.schema';
import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';

export const upsertReactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpsertReactionSchema;
}) => {
  try {
    await upsertReaction({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserReactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetReactionInput;
}) => {
  try {
    await getUserReaction({ ...input, userId: ctx.user.id, select: reactionSelect });
  } catch (error) {
    throw throwDbError(error);
  }
};
