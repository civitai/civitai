import { TRPCError } from '@trpc/server';

import type { Context } from '~/server/createContext';
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

export async function unpublishArticleHandler({
  input,
  ctx,
}: {
  input: UnpublishArticleSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id } = input;

    // Fetch current metadata
    const article = await dbRead.article.findUnique({
      where: { id },
      select: { metadata: true, nsfw: true },
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

    // Optional: Track analytics event (if article tracking exists)
    // if (ctx.track.articleEvent) {
    //   await ctx.track.articleEvent({
    //     type: 'Unpublish',
    //     articleId: id,
    //     nsfw: article.nsfw,
    //   });
    // }

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
  ctx: DeepNonNullable<Context>;
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
