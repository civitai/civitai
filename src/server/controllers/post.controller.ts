import { GetByIdInput } from './../schema/base.schema';
import {
  PostUpdateInput,
  AddPostImageInput,
  ReorderPostImagesInput,
  AddPostTagInput,
  RemovePostTagInput,
  UpdatePostImageInput,
  GetPostTagsInput,
  PostsQueryInput,
} from './../schema/post.schema';
import {
  createPost,
  getPostDetail,
  updatePost,
  addPostImage,
  reorderPostImages,
  deletePost,
  addPostTag,
  removePostTag,
  getPostEditDetail,
  updatePostImage,
  getPostTags,
  getPostsInfinite,
  getPostResources,
} from './../services/post.service';
import { TRPCError } from '@trpc/server';
import { PostCreateInput } from '~/server/schema/post.schema';
import {
  throwDbError,
  throwNotFoundError,
  throwAuthorizationError,
} from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';

export const getPostsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: PostsQueryInput;
  ctx: Context;
}) => {
  try {
    return await getPostsInfinite({ ...input, user: ctx.user });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

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
    await updatePost(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export type PostDetail = AsyncReturnType<typeof getPostHandler>;
export const getPostHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const post = await getPostDetail({ ...input, user: ctx.user });
    if (!post) throw throwNotFoundError();
    return post;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export type PostEditDetail = AsyncReturnType<typeof getPostEditHandler>;
export type PostEditImage = PostEditDetail['images'][0] & { previewUrl?: string };
export const getPostEditHandler = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const post = await getPostEditDetail(input);
    if (!post) throw throwNotFoundError();
    const isOwnerOrModerator = post.userId === ctx.user?.id || ctx.user?.isModerator;
    if (!isOwnerOrModerator) throw throwAuthorizationError();
    return post;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deletePostHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await deletePost({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

// #region [post images]
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

export const updatePostImageHandler = async ({
  input,
}: {
  input: UpdatePostImageInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await updatePostImage({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const reorderPostImagesHandler = async ({
  input,
}: {
  input: ReorderPostImagesInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await reorderPostImages({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
// #endregion

// #region [post tags]
export const getPostTagsHandler = async ({ input }: { input: GetPostTagsInput }) => {
  try {
    return await getPostTags({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const addPostTagHandler = async ({
  input,
  ctx,
}: {
  input: AddPostTagInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await addPostTag({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const removePostTagHandler = async ({
  input,
  ctx,
}: {
  input: RemovePostTagInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await removePostTag({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
// #endregion

// #region [post resources]
export const getPostResourcesHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    return await getPostResources({ ...input });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
// #endregion
