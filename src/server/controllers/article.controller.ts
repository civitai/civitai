import { TRPCError } from '@trpc/server';

import type { ProtectedContext } from '~/server/createContext';
import type {
  UpsertArticleInput,
  UnpublishArticleSchema,
  RestoreArticleSchema,
  ArticleMetadata,
} from '~/server/schema/article.schema';
import {
  unpublishArticleById,
  upsertArticle,
  restoreArticleById,
} from '~/server/services/article.service';
import { getCategoryTags } from '~/server/services/system-cache';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { dbRead } from '~/server/db/client';

export const upsertArticleHandler = async ({
  input,
  ctx,
}: {
  input: UpsertArticleInput;
  ctx: ProtectedContext;
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

    const result = await upsertArticle({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      scanContent,
    });

    // Track provenance (web vs. API key vs. OAuth app) for moderation tracing.
    // nsfw is best-effort false here — an article's nsfwLevel is derived
    // asynchronously after create, so it isn't reliable at this point.
    await ctx.track.article({
      type: input.id ? 'Update' : 'Create',
      articleId: result.id,
      nsfw: false,
    });

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export async function unpublishArticleHandler({
  input,
  ctx,
}: {
  input: UnpublishArticleSchema;
  ctx: ProtectedContext;
}) {
  try {
    const { id } = input;

    // Fetch current metadata
    const article = await dbRead.article.findUnique({
      where: { id },
      select: { metadata: true },
    });

    if (!article) throw throwNotFoundError(`No article with id ${input.id}`);

    const metadata = (article.metadata as ArticleMetadata | null) || {};

    // Call service with enhanced parameters
    const updatedArticle = await unpublishArticleById({
      ...input,
      metadata,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    return {
      ...updatedArticle,
      metadata: updatedArticle.metadata as ArticleMetadata | null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
}

export async function restoreArticleHandler({
  input,
  ctx,
}: {
  input: RestoreArticleSchema;
  ctx: ProtectedContext;
}) {
  try {
    const { id } = input;
    const restoredArticle = await restoreArticleById({
      id,
      userId: ctx.user.id,
    });
    return {
      ...restoredArticle,
      metadata: restoredArticle.metadata as ArticleMetadata | null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
}
