import { TRPCError } from '@trpc/server';

import type { Context } from '~/server/createContext';
import type { UpsertArticleInput } from '~/server/schema/article.schema';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { unpublishArticleById, upsertArticle } from '~/server/services/article.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { throwAuthorizationError, throwDbError } from '~/server/utils/errorHandling';

export const upsertArticleHandler = async ({
  input,
  ctx,
}: {
  input: UpsertArticleInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const categories = await getCategoryTags('article');
    const adminOnlyCategories = categories.filter((category) => category.adminOnly);
    const includesAdminOnlyTag = input.tags?.some(
      (tag) => adminOnlyCategories.findIndex((category) => category.name === tag.name) !== -1
    );
    // Only users with adminTags featureFlag can add adminOnly tags
    if (includesAdminOnlyTag && !ctx.features.adminTags) throw throwAuthorizationError();
    const scanContent = ctx.features.articleImageScanning ?? false;

    return upsertArticle({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      scanContent,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export function unpublishArticleHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return unpublishArticleById({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
}
