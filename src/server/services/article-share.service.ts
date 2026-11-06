import { dbWrite } from '~/server/db/client';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  AccessTokenLimitError,
  createAccessToken,
  getAccessTokenById,
  getActiveAccessTokens,
  resolveAccessToken,
  revokeAccessToken,
} from '~/server/services/access-token.service';
import { articleHasText, updateArticleImageScanStatus } from '~/server/services/article.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { isShareableArticleStatus } from '~/server/services/text-scan/public-content';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { amIBlockedByUser } from '~/server/services/user.service';
import { articleContentJson } from '~/server/utils/article-content-json';
import {
  handleLogError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { NsfwLevel } from '~/server/common/enums';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';
import { getArticleUrl, removeTags } from '~/utils/string-helpers';

export const ARTICLE_SHARE_MAX_ACTIVE = 5;

async function getOwnArticle(articleId: number, userId: number) {
  const article = await dbWrite.article.findUnique({
    where: { id: articleId },
    select: { id: true, userId: true, status: true },
  });
  // Not found rather than forbidden, so a stranger learns nothing about someone else's draft.
  if (!article || article.userId !== userId) throw throwNotFoundError('Article not found');
  return article;
}

/**
 * Sends the article's current text for the same checks a published article gets, then
 * recomputes its ingestion. Until that verdict is in, ingestion is not Scanned and the shared
 * read answers "still being checked". Throws when the text could not be sent.
 */
async function checkSharedArticle(articleId: number) {
  const article = await dbWrite.article.findUnique({
    where: { id: articleId },
    select: { title: true, content: true },
  });
  if (article && articleHasText(article.title, article.content)) {
    const content = [article.title, removeTags(article.content ?? '')].filter(Boolean).join(' ');
    await submitTextModerationOrScan({
      entityType: 'Article',
      entityId: articleId,
      xguard: () =>
        submitTextModeration({
          entityType: 'Article',
          entityId: articleId,
          content,
          labels: ['nsfw'],
          recordForReview: true,
          rearmRetries: true,
        }),
    });
  }
  await updateArticleImageScanStatus([articleId]);
}

export async function createArticleShareLink({
  articleId,
  expiresInDays,
  userId,
}: {
  articleId: number;
  expiresInDays: number;
  userId: number;
}) {
  const article = await getOwnArticle(articleId, userId);
  if (!isShareableArticleStatus(article.status))
    throw throwBadRequestError('Only an unpublished draft can be shared with a link');

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  let created: Awaited<ReturnType<typeof createAccessToken>>;
  try {
    created = await createAccessToken({
      resourceType: 'Article',
      resourceId: articleId,
      createdById: userId,
      expiresAt,
      maxActive: ARTICLE_SHARE_MAX_ACTIVE,
    });
  } catch (e) {
    if (e instanceof AccessTokenLimitError)
      throw throwBadRequestError(
        `An article can have at most ${ARTICLE_SHARE_MAX_ACTIVE} active share links. Revoke one to create another.`
      );
    throw e;
  }

  const { token, row } = created;
  // After the token exists: the checks only run for an article that is shared. A link whose
  // checks could not start is withdrawn rather than left to show text nobody checked.
  try {
    await checkSharedArticle(articleId);
  } catch (e) {
    handleLogError(e as Error, 'article-share-check', { articleId });
    await revokeAccessToken(row.id);
    throw throwBadRequestError('Could not prepare the share link. Please try again.');
  }

  return { id: row.id, token, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export async function getArticleShareLinks({
  articleId,
  userId,
}: {
  articleId: number;
  userId: number;
}) {
  await getOwnArticle(articleId, userId);
  return getActiveAccessTokens('Article', articleId);
}

/** Any status: an author can always kill a link. */
export async function revokeArticleShareLink({ id, userId }: { id: number; userId: number }) {
  const row = await getAccessTokenById(id);
  if (!row || row.resourceType !== 'Article') throw throwNotFoundError('Share link not found');
  const article = await dbWrite.article.findUnique({
    where: { id: row.resourceId },
    select: { userId: true },
  });
  if (row.createdById !== userId && article?.userId !== userId)
    throw throwNotFoundError('Share link not found');
  await revokeAccessToken(id);
}

export type SharedArticleResult =
  | { status: 'unavailable' }
  | { status: 'checking' }
  | { status: 'published'; url: string }
  | { status: 'ok'; article: SharedArticle };

export type SharedArticle = NonNullable<Awaited<ReturnType<typeof loadSharedArticle>>>;

const UNAVAILABLE = { status: 'unavailable' } as const;

/**
 * The only read path a share token opens. It grants this one article, read-only, and nothing
 * else: the token never reaches `getById` or the session.
 */
export async function getArticleByShareToken({
  token,
  viewerId,
}: {
  token: string;
  viewerId?: number;
}): Promise<SharedArticleResult> {
  const row = await resolveAccessToken(token, 'Article');
  if (!row) return UNAVAILABLE;

  const article = await dbWrite.article.findUnique({
    where: { id: row.resourceId },
    select: {
      id: true,
      title: true,
      userId: true,
      status: true,
      ingestion: true,
      user: { select: { bannedAt: true, muted: true, deletedAt: true } },
    },
  });
  if (!article) return UNAVAILABLE;
  // A link outlives nothing about its author: a transferred article, or a banned, muted or
  // deleted author, ends it.
  if (article.userId !== row.createdById) return UNAVAILABLE;
  if (article.user.bannedAt || article.user.muted || article.user.deletedAt) return UNAVAILABLE;
  if (viewerId && (await amIBlockedByUser({ userId: viewerId, targetUserId: article.userId })))
    return UNAVAILABLE;

  if (article.status === ArticleStatus.Published)
    return { status: 'published', url: getArticleUrl(article) };
  if (!isShareableArticleStatus(article.status)) return UNAVAILABLE;

  if (article.ingestion !== ArticleIngestionStatus.Scanned) {
    const settling =
      article.ingestion === ArticleIngestionStatus.Pending ||
      article.ingestion === ArticleIngestionStatus.Rescan;
    return settling ? { status: 'checking' } : UNAVAILABLE;
  }

  const shared = await loadSharedArticle(article.id);
  return shared ? { status: 'ok', article: shared } : UNAVAILABLE;
}

async function loadSharedArticle(id: number) {
  const article = await dbWrite.article.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      content: true,
      nsfwLevel: true,
      updatedAt: true,
      user: { select: userWithCosmeticsSelect },
      coverImage: { select: imageSelect },
    },
  });
  if (!article) return null;

  const { coverImage, content, ...rest } = article;
  const showCover = coverImage?.ingestion === 'Scanned' && !coverImage.needsReview;
  return {
    ...rest,
    nsfwLevel: article.nsfwLevel as NsfwLevel,
    content,
    contentJson: content ? articleContentJson(content) : undefined,
    coverImage:
      showCover && coverImage
        ? {
            ...coverImage,
            nsfwLevel: coverImage.nsfwLevel as NsfwLevel,
            meta: coverImage.meta as ImageMetaProps,
            metadata: coverImage.metadata as ImageMetadata,
            tags: coverImage.tags.flatMap((x) => x.tag.id),
          }
        : undefined,
  };
}
