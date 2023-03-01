import { GetByIdInput } from './../schema/base.schema';
import { PostUpdateInput, AddPostImageInput } from './../schema/post.schema';
import { createPost, getPost, updatePost, addPostImage } from './../services/post.service';
import { TRPCError } from '@trpc/server';
import { PostCreateInput } from '~/server/schema/post.schema';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';

export const createPostHandler = async ({
  input,
  ctx,
}: {
  input: PostCreateInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await createPost({ userId: ctx.user.id, ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updatePostHandler = async ({ input }: { input: PostUpdateInput }) => {
  try {
    return await updatePost(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export type PostDetail = AsyncReturnType<typeof getPostHandler>;
export const getPostHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const post = await getPost(input);
    if (!post) throw throwNotFoundError();
    const isOwnerOrModerator = post.user.id === ctx.user?.id || ctx.user?.isModerator;
    if (!post.scanned && !isOwnerOrModerator) throw throwNotFoundError();
    return post;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const addPostImageHandler = async ({
  input,
  ctx,
}: {
  input: AddPostImageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await addPostImage({ ...input, userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
