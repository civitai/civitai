import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import {
  AddCollectionItemInput,
  GetAllUserCollectionsInputSchema,
  UpsertCollectionInput,
} from '~/server/schema/collection.schema';
import {
  addCollectionItems,
  getUserCollectionsWithPermissions,
  upsertCollection,
} from '~/server/services/collection.service';
import { TRPCError } from '@trpc/server';

export const getAllUserCollectionsHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetAllUserCollectionsInputSchema;
}) => {
  const { user } = ctx;
  const { permission } = input;

  try {
    const collections = await getUserCollectionsWithPermissions({
      user,
      permissions: [permission],
      select: {
        id: true,
        name: true,
        description: true,
        coverImage: true,
      },
    });

    return collections;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const addItemHandlers = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: AddCollectionItemInput;
}) => {
  const { user } = ctx;

  try {
    return await addCollectionItems({ user, input });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertCollectionHandler = async ({
  input,
  ctx,
}: {
  input: UpsertCollectionInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;

  try {
    const collection = await upsertCollection({ input, user });

    return collection;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
