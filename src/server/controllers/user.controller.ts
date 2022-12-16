import { Context } from '~/server/createContext';
import {
  getCreators,
  getUserCreator,
  getUserFavoriteModelByModelId,
  getUserFavoriteModels,
  getUserUnreadNotificationsCount,
  toggleFollowUser,
  toggleHideUser,
} from '~/server/services/user.service';
import { TRPCError } from '@trpc/server';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllUsersInput,
  UserUpsertInput,
  GetUserByUsernameSchema,
  ToggleFavoriteModelInput,
  ToggleFollowUserSchema,
} from '~/server/schema/user.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { deleteUser, getUserById, getUsers, updateUserById } from '~/server/services/user.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export const getAllUsersHandler = async ({ input }: { input: GetAllUsersInput }) => {
  try {
    return await getUsers({
      ...input,
      select: {
        username: true,
        id: true,
      },
    });
  } catch (error) {
    throwDbError(error);
  }
};

export const getUserCreatorHandler = async ({
  input: { username },
}: {
  input: GetUserByUsernameSchema;
}) => {
  try {
    return await getUserCreator({ username });
  } catch (error) {
    throwDbError(error);
  }
};

export const getUserByIdHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const user = await getUserById({ ...input, select: simpleUserSelect });

    if (!user) {
      throw throwNotFoundError(`No user with id ${input.id}`);
    }

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const getNotificationSettingsHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  const { id } = ctx.user;

  try {
    const user = await getUserById({
      id,
      select: { notificationSettings: { select: { id: true, type: true, disabledAt: true } } },
    });

    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    return user.notificationSettings;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const checkUserNotificationsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const { id } = ctx.user;

  try {
    const user = await getUserUnreadNotificationsCount({ id });
    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    return { count: user._count.notifications };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const updateUserHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: Partial<UserUpsertInput>;
}) => {
  const { id, ...data } = input;
  const currentUser = ctx.user;
  if (id !== currentUser.id) throw throwAuthorizationError();

  try {
    const updatedUser = await updateUserById({ id, data });

    if (!updatedUser) {
      throw throwNotFoundError(`No user with id ${id}`);
    }

    return updatedUser;
  } catch (error) {
    if (error instanceof TRPCError) throw error; // Rethrow the error if it's already a TRCPError
    else throwDbError(error); // Otherwise, generate a db error
  }
};

export const deleteUserHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  const { id } = input;
  const currentUser = ctx.user;
  if (id !== currentUser.id) throw throwAuthorizationError();

  try {
    const user = await deleteUser({ id });

    if (!user) {
      throw throwNotFoundError(`No user with id ${id}`);
    }

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const getUserFavoriteModelsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const { id } = ctx.user;

  try {
    const user = await getUserFavoriteModels({ id });

    if (!user) throw throwNotFoundError(`No user with id ${id}`);

    return user.favoriteModels;
  } catch (error) {
    throwDbError(error);
  }
};

export const toggleFavoriteModelHandler = async ({
  input,
  ctx,
}: {
  input: ToggleFavoriteModelInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id: userId } = ctx.user;
  const favoriteModel = await getUserFavoriteModelByModelId({ ...input, userId });

  try {
    const user = await updateUserById({
      id: userId,
      data: {
        favoriteModels: {
          create: favoriteModel ? undefined : { ...input },
          deleteMany: favoriteModel ? { ...input, userId } : undefined,
        },
      },
    });

    if (!user) throw throwNotFoundError(`No user with id ${userId}`);

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const getCreatorsHandler = async ({ input }: { input: Partial<GetAllSchema> }) => {
  const { limit = DEFAULT_PAGE_SIZE, page, query } = input;
  const { take, skip } = getPagination(limit, page);

  try {
    const results = await getCreators({
      query,
      take,
      skip,
      count: true,
      select: { username: true, models: { select: { id: true } } },
    });

    return getPagingData(results, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserFollowingListHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id: userId } = ctx.user;
    const user = await getUserById({
      id: userId,
      select: {
        engagingUsers: {
          where: { type: 'Follow' },
          select: { targetUser: { select: { id: true, username: true } } },
        },
      },
    });

    if (!user) throw throwNotFoundError(`No user with id ${userId}`);

    return user.engagingUsers.map(({ targetUser }) => targetUser);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleFollowUserHandler = async ({
  input,
  ctx,
}: {
  input: ToggleFollowUserSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    await toggleFollowUser({ ...input, userId });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getUserHiddenListHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const { id: userId } = ctx.user;
    const user = await getUserById({
      id: userId,
      select: {
        engagingUsers: {
          where: { type: 'Hide' },
          select: { targetUser: { select: { id: true, username: true } } },
        },
      },
    });

    if (!user) throw throwNotFoundError(`No user with id ${userId}`);

    return user.engagingUsers.map(({ targetUser }) => targetUser);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const toggleHideUserHandler = async ({
  input,
  ctx,
}: {
  input: ToggleFollowUserSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    await toggleHideUser({ ...input, userId });
  } catch (error) {
    throw throwDbError(error);
  }
};
