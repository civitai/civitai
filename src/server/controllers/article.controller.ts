import { TRPCError } from '@trpc/server';

import type { ProtectedContext } from '~/server/createContext';
import type {
  UpsertArticleInput,
  UnpublishArticleSchema,
  ArticleMetadata,
} from '~/server/schema/article.schema';
import { unpublishArticleById, upsertArticle } from '~/server/services/article.service';
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

    // Capture the prior published state so we can tell a publish transition apart
    // from an edit of an already-published article. Only needed for updates; a
    // new article has no prior state. (Article saves are low volume.)
    const wasPublished = input.id
      ? !!(
          await dbRead.article.findUnique({
            where: { id: input.id },
            select: { publishedAt: true },
          })
        )?.publishedAt
      : false;

    const result = await upsertArticle({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      scanContent,
    });

    // Track provenance (web vs. API key vs. OAuth app) for moderation tracing.
    // nsfw is best-effort false here — an article's nsfwLevel is derived
    // asynchronously after create, so it isn't reliable at this point.
    const willBePublished = !!input.publishedAt;
    const type: 'Create' | 'Publish' | 'Update' = !input.id
      ? willBePublished
        ? 'Publish'
        : 'Create'
      : willBePublished && !wasPublished
      ? 'Publish'
      : 'Update';
    await ctx.track.article({ type, articleId: result.id, nsfw: false });

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

    await ctx.track.article({ type: 'Unpublish', articleId: id, nsfw: false });

    return {
      ...updatedArticle,
      metadata: updatedArticle.metadata as ArticleMetadata | null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
}

// NOTE(moderator-migration): restoreArticleHandler removed — article restore is now a moderator-app
// action (apps/moderator, Kysely). See docs/moderator-app/context-menu-mod-actions.md.
