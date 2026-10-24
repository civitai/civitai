import type { GetByIdInput } from './../schema/base.schema';
import type { UpsertUserLinkParams } from './../schema/user-link.schema';
import {
  deleteUserLink,
  upsertManyUserLinks,
  upsertUserLink,
} from './../services/user-link.service';
import { bustUserCreator } from '~/server/services/user-creator.service';
import type { Context, ProtectedContext } from '~/server/createContext';
import type { UpsertManyUserLinkParams, GetUserLinksQuery } from '~/server/schema/user-link.schema';
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
  ctx: ProtectedContext;
  input: UpsertManyUserLinkParams;
}) => {
  await upsertManyUserLinks({ data: input, userId: ctx.user.id });
  await bustUserCreator(ctx.user.id);
};

export const upsertUserLinkHandler = async ({
  input,
  ctx,
}: {
  ctx: ProtectedContext;
  input: UpsertUserLinkParams;
}) => {
  await upsertUserLink({ ...input, userId: ctx.user.id });
  await bustUserCreator(ctx.user.id);
};

export const deleteUserLinkHandler = async ({
  input,
  ctx,
}: {
  ctx: ProtectedContext;
  input: GetByIdInput;
}) => {
  await deleteUserLink({ id: input.id, userId: ctx.user.id });
  await bustUserCreator(ctx.user.id);
};
