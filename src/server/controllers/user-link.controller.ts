import { GetByIdInput } from './../schema/base.schema';
import { UpsertUserLinkParams } from './../schema/user-link.schema';
import {
  deleteUserLink,
  upsertManyUserLinks,
  upsertUserLink,
} from './../services/user-link.service';
import { Context } from '~/server/createContext';
import { UpsertManyUserLinkParams, GetUserLinksQuery } from '~/server/schema/user-link.schema';
import { getUserLinks } from '~/server/services/user-link.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export type GetUserLinksResult = AsyncReturnType<typeof getUserLinksHandler>;
export const getUserLinksHandler = async ({
  input,
  ctx,
}: {
  input: GetUserLinksQuery;
  ctx: Context;
}) => {
  const userId = input.userId || ctx.user?.id;
  if (!userId) {
    throw throwBadRequestError();
  }
  return await getUserLinks({ userId });
};

export const upsertManyUserLinksHandler = async ({
  input,
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpsertManyUserLinkParams;
}) => {
  await upsertManyUserLinks({ data: input, userId: ctx.user.id });
};

export const upsertUserLinkHandler = async ({
  input,
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpsertUserLinkParams;
}) => {
  await upsertUserLink({ ...input, userId: ctx.user.id });
};

export const deleteUserLinkHandler = async ({
  input,
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  await deleteUserLink({ id: input.id, userId: ctx.user.id });
};
