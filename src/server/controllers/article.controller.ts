import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import { UpsertArticleInput } from '~/server/schema/article.schema';
import { upsertArticle } from '~/server/services/article.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
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
    const features = getFeatureFlags({ user: ctx.user });
    const includesAdminOnlyTag = input.tags?.some(
      (tag) => adminOnlyCategories.findIndex((category) => category.name === tag.name) !== -1
    );
    // Only users with adminTags featureFlag can add adminOnly tags
    if (includesAdminOnlyTag && !features.adminTags) throw throwAuthorizationError();

    return upsertArticle({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
