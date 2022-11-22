import { PrismaClientKnownRequestError } from '@prisma/client/runtime';
import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAllUsersInput, UserUpsertInput } from '~/server/schema/user.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { deleteUser, getUserById, getUsers, updateUserById } from '~/server/services/user.service';
import { handleAuthorizationError, handleDbError } from '~/server/utils/errorHandling';

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
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};

export const getUserByIdHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const user = await getUserById({ ...input, select: simpleUserSelect });

    if (!user) {
      throw handleDbError({ code: 'NOT_FOUND', message: `No user with id ${input.id}` });
    }

    return user;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
  if (id !== currentUser.id) return handleAuthorizationError();

  try {
    const updatedUser = await updateUserById({ id, data });

    if (!updatedUser) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `No user with id ${id}`,
      });
    }

    return updatedUser;
  } catch (error) {
    if (error instanceof PrismaClientKnownRequestError) {
      // TODO Error Handling: Add more robust TRPC<->prisma error handling
      // console.log('___ERROR___');
      // console.log(error.code);
      // console.log(error.meta?.target); // target is the field(s) that had a problem
      if (error.code === 'P2002')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This username is not available.',
        });
    }

    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
  if (id !== currentUser.id) return handleAuthorizationError();

  try {
    const user = await deleteUser({ id });

    if (!user) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `No user with id ${id}`,
      });
    }

    return user;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};
