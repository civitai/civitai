import { GetByIdInput } from './../schema/base.schema';
import { upsertComment, getComments, deleteComment } from './../services/commentsv2.service';
import { UpsertCommentV2Input, GetCommentsV2Input } from './../schema/commentv2.schema';
import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { commentV2Select } from '~/server/selectors/commentv2.selector';

export const getCommentsV2Handler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetCommentsV2Input;
}) => {
  try {
    await getComments({ ...input, select: commentV2Select });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertCommentV2Handler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpsertCommentV2Input;
}) => {
  try {
    await upsertComment({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteCommentV2Handler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    await deleteComment(input);
  } catch (error) {
    throw throwDbError(error);
  }
};
