import { GetByIdInput } from './../schema/base.schema';
import {
  upsertComment,
  getComments,
  deleteComment,
  getCommentCount,
  getCommentsThreadDetails,
  toggleLockCommentsThread,
} from './../services/commentsv2.service';
import {
  UpsertCommentV2Input,
  GetCommentsV2Input,
  CommentConnectorInput,
} from './../schema/commentv2.schema';
import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { commentV2Select } from '~/server/selectors/commentv2.selector';

export type InfiniteCommentResults = AsyncReturnType<typeof getInfiniteCommentsV2Handler>;
export const getInfiniteCommentsV2Handler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: GetCommentsV2Input;
}) => {
  try {
    input.limit = input.limit ?? 20;
    const limit = input.limit + 1;

    const comments = await getComments({
      ...input,
      limit,
      select: commentV2Select,
    });

    let nextCursor: number | undefined;
    if (comments.length > input.limit) {
      const nextItem = comments.pop();
      nextCursor = nextItem?.id;
    }

    return {
      nextCursor,
      comments,
    };
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
    return await upsertComment({ ...input, userId: ctx.user.id });
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

export const getCommentCountV2Handler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: CommentConnectorInput;
}) => {
  try {
    return await getCommentCount(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getCommentsThreadDetailsHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input: CommentConnectorInput;
}) => {
  try {
    return await getCommentsThreadDetails(input);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const toggleLockThreadDetailsHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: CommentConnectorInput;
}) => {
  try {
    await toggleLockCommentsThread(input);
  } catch (error) {
    throw throwDbError(error);
  }
};
