import { Context } from "~/server/createContext";
import { throwDbError } from "~/server/utils/errorHandling";
import {
  AddCollectionItemInput,
  GetAllUserCollectionsInputSchema,
} from "~/server/schema/collection.schema";
import {
  addCollectionItems,
  getUserCollectionsWithPermissions,
} from "~/server/services/collection.service";

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
