import { Context } from '~/server/createContext';
import {
  getUserFavoriteModelByModelId,
  getUserFavoriteModels,
  getUserModelStats,
} from '~/server/services/user.service';
import { TRPCError } from '@trpc/server';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllUsersInput,
  UserUpsertInput,
  GetUserByUsernameSchema,
  ToggleFavoriteModelInput,
} from '~/server/schema/user.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { deleteUser, getUserById, getUsers, updateUserById } from '~/server/services/user.service';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

export const getUserStatsHandler = async ({ input }: { input: GetUserByUsernameSchema }) => {
  const rankStats = await getUserModelStats({ input });

  return { rank: rankStats };
};

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
    return user?.favoriteModels ?? [];
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
