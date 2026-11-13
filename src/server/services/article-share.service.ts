import { Prisma } from '@prisma/client';
import { servableArticleImage } from '~/shared/utils/article-card-image';
import { dbWrite } from '~/server/db/client';
import { sysRedis } from '~/server/redis/client';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  AccessTokenLimitError,
  AccessTokenNotAllowedError,
  createAccessToken,
  getAccessTokenById,
  getActiveAccessTokens,
  resolveAccessToken,
  revokeAccessToken,
} from '~/server/services/access-token.service';
import {
  articleHasText,
  submitSharedArticleText,
  updateArticleImageScanStatus,
} from '~/server/services/article.service';
import { sharedArticleTextHash } from '~/server/services/article-share.helpers';
import { shareTokenSchema } from '~/server/schema/article.schema';
import { csamHoldBars } from '~/server/services/text-scan/csam-hold-bars';
import { isShareableArticleStatus } from '~/server/services/text-scan/public-content';
import { amIBlockedByUser } from '~/server/services/user.service';
import { articleContentJson } from '~/server/utils/article-content-json';
import {
  handleLogError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { NsfwLevel } from '~/server/common/enums';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  EntityModerationStatus,
} from '~/shared/utils/prisma/enums';
import { getArticleUrl } from '~/utils/string-helpers';

export const ARTICLE_SHARE_MAX_ACTIVE = 5;
const NOT_SHAREABLE = 'Only an unpublished draft can be shared with a link';

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
 * Sends the article's current text for a fresh check, then recomputes its ingestion. Until that
 * check passes, the shared read answers "still being checked". Throws when the check could not be
 * shown to have started for the stored text.
 */
async function checkSharedArticle(articleId: number) {
  if (!(await submitSharedArticleText(articleId))) throw new Error('The share check did not start');
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
  if (!isShareableArticleStatus(article.status)) throw throwBadRequestError(NOT_SHAREABLE);

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  let created: Awaited<ReturnType<typeof createAccessToken>>;
  try {
    created = await createAccessToken({
      resourceType: 'Article',
      resourceId: articleId,
      createdById: userId,
      expiresAt,
      maxActive: ARTICLE_SHARE_MAX_ACTIVE,
      // A publish landing after the check above revokes under this lock; a link made after it must not survive.
      allowed: async (tx) => {
        const current = await tx.article.findUnique({
          where: { id: articleId },
          select: { status: true },
        });
        return !!current && isShareableArticleStatus(current.status);
      },
    });
  } catch (e) {
    if (e instanceof AccessTokenNotAllowedError) throw throwBadRequestError(NOT_SHAREABLE);
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
  isModerator,
}: {
  articleId: number;
  userId: number;
  isModerator?: boolean;
}) {
  if (!isModerator) await getOwnArticle(articleId, userId);
  return getActiveAccessTokens('Article', articleId);
}

/** Any status: an author or a moderator can always kill a link. */
export async function revokeArticleShareLink({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
}) {
  const row = await getAccessTokenById(id);
  if (!row || row.resourceType !== 'Article') throw throwNotFoundError('Share link not found');
  const article = await dbWrite.article.findUnique({
    where: { id: row.resourceId },
    select: { userId: true },
  });
  if (!isModerator && row.createdById !== userId && article?.userId !== userId)
    throw throwNotFoundError('Share link not found');
  await revokeAccessToken(id);
}

/**
 * Which article a link opens, or null. Unknown, expired and revoked tokens answer the same, so the
 * link page reveals nothing about a dead one.
 */
export async function openArticleShareLink(shareToken: string) {
  const row = await resolveAccessToken(shareToken, 'Article');
  return row ? { articleId: row.resourceId, expiresAt: row.expiresAt } : null;
}

export type SharedArticleResult =
  | { status: 'unavailable' }
  | { status: 'checking' }
  | { status: 'published'; url: string }
  | { status: 'ok'; article: SharedArticle };

export type SharedArticle = ReturnType<typeof toSharedArticle>;

const UNAVAILABLE = { status: 'unavailable' } as const;

const RECHECK_WINDOW_SECONDS = 5 * 60;

/** Runs the share check again, at most once per window per article, whatever reads it. */
async function recheckSharedArticle(articleId: number) {
  try {
    const claimed = await sysRedis.set(`article-share:recheck:${articleId}` as never, '1', {
      NX: true,
      EX: RECHECK_WINDOW_SECONDS,
    });
    if (claimed === null) return;
    if (await submitSharedArticleText(articleId)) await updateArticleImageScanStatus([articleId]);
  } catch (e) {
    handleLogError(e as Error, 'article-share-recheck', { articleId });
  }
}

/**
 * The only read path a share token opens. It grants this one article, read-only, and nothing
 * else: the token never reaches `getById` or the session.
 */
export async function getArticleByShareToken({
  articleId,
  shareToken,
  viewerId,
}: {
  articleId: number;
  shareToken: string | undefined;
  viewerId?: number;
}): Promise<SharedArticleResult> {
  if (!shareToken || !shareTokenSchema.safeParse(shareToken).success) return UNAVAILABLE;
  const row = await resolveAccessToken(shareToken, 'Article');
  if (!row || row.resourceId !== articleId) return UNAVAILABLE;

  // One read, so the text shown is the text whose state was checked.
  const { article, check, required, holds } = await readSharedArticle(row.resourceId);
  if (!article) return UNAVAILABLE;
  if (csamHoldBars(check, holds)) {
    // A failed check (its hold write failed, or a partial result) clears only by a rescan.
    if (check?.status === EntityModerationStatus.Failed) await recheckSharedArticle(article.id);
    return UNAVAILABLE;
  }
  // A transfer, or a banned, muted or deleted author, makes the link answer unavailable meanwhile.
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
    if (article.ingestion === ArticleIngestionStatus.Error) await recheckSharedArticle(article.id);
    return settling ? { status: 'checking' } : UNAVAILABLE;
  }

  // The read requires the verdict of the current text's check.
  if (articleHasText(article.title, article.content)) {
    if (check?.blocked) return UNAVAILABLE;
    const current =
      !!required?.workflowId &&
      required.textHash === sharedArticleTextHash(article) &&
      check?.workflowId === required.workflowId &&
      check.status === EntityModerationStatus.Succeeded;
    if (!current) {
      // Another path's check (a retry, a rescan, a publish) replaced the one recorded here, or
      // none finished: once nothing is in flight, run the share check again.
      if (check?.status !== EntityModerationStatus.Pending) await recheckSharedArticle(article.id);
      return { status: 'checking' };
    }
  }

  return { status: 'ok', article: toSharedArticle(article) };
}

/** Everything the read decides on, from one snapshot. */
async function readSharedArticle(id: number) {
  const [article, check, required, holds] = await dbWrite.$transaction(
    [
      readSharedArticleRow(id),
      dbWrite.entityModeration.findUnique({
        where: { entityType_entityId: { entityType: 'Article', entityId: id } },
        select: {
          status: true,
          blocked: true,
          workflowId: true,
          triggeredLabels: true,
          result: true,
        },
      }),
      dbWrite.articleShareCheck.findUnique({
        where: { articleId: id },
        select: { workflowId: true, textHash: true },
      }),
      dbWrite.textScanHold.findMany({
        where: { entityType: 'Article', entityId: id, label: 'csam', status: { not: 'Confirmed' } },
        select: { status: true, textHash: true, meta: true },
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  return { article, check, required, holds };
}

function readSharedArticleRow(id: number) {
  return dbWrite.article.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      content: true,
      nsfwLevel: true,
      updatedAt: true,
      userId: true,
      status: true,
      ingestion: true,
      user: { select: { ...userWithCosmeticsSelect, bannedAt: true, muted: true } },
      coverImage: { select: imageSelect },
      bannerImage: { select: imageSelect },
    },
  });
}

/** Only what the read-only view renders. */
function toSharedArticle(article: NonNullable<Awaited<ReturnType<typeof readSharedArticleRow>>>) {
  const { id, title, content, nsfwLevel, updatedAt } = article;
  // The banner stands in for a missing cover.
  const coverImage = article.coverImage ?? article.bannerImage;
  const { bannedAt: _bannedAt, muted: _muted, ...user } = article.user;
  const showCover = servableArticleImage(coverImage) !== null;
  return {
    id,
    title,
    content,
    updatedAt,
    user,
    nsfwLevel: nsfwLevel as NsfwLevel,
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
