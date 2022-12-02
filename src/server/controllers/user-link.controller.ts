import { upsertManyUserLinks } from './../services/user-link.service';
import { Context } from '~/server/createContext';
import { UserLinkParams, GetUserLinksQuery } from '~/server/schema/user-link.schema';
import { getUserLinks } from '~/server/services/user-link.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

export const getUserLinksHandler = async ({ input: { userId } }: { input: GetUserLinksQuery }) => {
  return await getUserLinks({ userId });
};

export const upsertManyUserLinksHandler = async ({
  input,
  ctx,
}: {
  ctx: Context;
  input: UserLinkParams[];
}) => {
  if (!ctx.user) {
    throw throwAuthorizationError();
  }
  await upsertManyUserLinks({ data: input, user: ctx.user });
};
