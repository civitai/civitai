import { detachHeldThreadsSql } from '~/server/services/comment-thread-hold';
import type { EventViewer } from '~/server/events/event-access';
import { Prisma } from '@prisma/client';
import { accountHoldSql, holdMarkerViewExists } from '~/server/services/legal-hold.service';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';
import { TRPCError } from '@trpc/server';
import type { ManipulateType } from 'dayjs';
import { truncate } from 'lodash-es';
import { NsfwLevel } from '~/server/common/enums';
import { hasBlockMarker } from '~/server/common/image-visibility';
import { ImageConnectionType, NotificationCategory } from '~/server/common/enums';
import { ArticleSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-lag-helpers';
import { eventEngine } from '~/server/events';
import { userArticleCountCache, articleStatCache } from '~/server/redis/caches';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import type {
  ArticleCursor,
  ArticleMetadata,
  GetInfiniteArticlesSchema,
  SetArticleOfficialInput,
  UpsertArticleInput,
} from '~/server/schema/article.schema';
import type { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { OFFICIAL_ARTICLE_TAG } from '~/shared/constants/article.constants';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { articlesSearchIndex } from '~/server/search-index';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { viewerReactionsSelect } from '~/server/selectors/reaction.selector';
import type {
  ContentDecorationCosmetic,
  EventDecorationCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { imageSelect, profileImageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { deriveArticleIngestionState } from '~/server/services/article-ingestion.helpers';
import { getArticleScheduleError } from '~/server/services/article-schedule.helpers';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { newTagNames } from '~/server/services/new-tag-names';
import {
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
} from '~/server/services/blurb-materialize.service';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import {
  getCosmeticsForEntity,
  getEventDecorationsForEntity,
} from '~/server/services/cosmetic.service';
import { resolveCoverImageId } from '~/server/services/cover-image.service';
import { shopArtworkUrls } from '~/server/services/image-url-ownership';
import {
  deleteImageById,
  enqueueImageIngestion,
  resolveIngestionError,
} from '~/server/services/image.service';
import {
  enqueueCollectionRebuild,
  getCollectionIdsForArticle,
} from '~/server/services/collection-media-index';
import { getCategoryTags, getSystemTags } from '~/server/services/system-cache';
import { amIBlockedByUser } from '~/server/services/user.service';
import { isImageOwner } from '~/server/services/util.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { enforceLockedProperties } from '~/server/utils/locked-properties';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import type { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import {
  ArticleEngagementType,
  ArticleIngestionStatus,
  ArticleStatus,
  Availability,
  EntityModerationStatus,
  ImageIngestionStatus,
  MetricTimeframe,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';
import { removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { getFilesByEntity } from './file.service';
import { generateJSON } from '~/server/utils/tiptap-generate-json';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import {
  ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE,
  assertClientImageUrlsUsable,
  assertClientKeysIssuedToCaller,
  COVER_IMAGE_UNAVAILABLE_MESSAGE,
  imageUrlUnavailableError,
  keyIssuers,
  keysIn,
} from '~/server/services/image-url-ownership';
import { createNotification } from '~/server/services/notification.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import {
  articleAwaitsTextVerdict,
  isPublicArticle,
} from '~/server/services/text-scan/public-content';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import {
  computeArticleDerivedNsfwLevel,
  maybeAutoResolveDisputeAfterScan,
  shouldRestampOverrideBasis,
} from '~/server/services/article-rating-review.helpers';

type ArticleRaw = {
  id: number;
  cover?: string | null;
  coverId?: number | null;
  title: string;
  publishedAt: Date | null;
  userNsfwLevel: number;
  nsfwLevel: number;
  availability: Availability;
  userId: number | null;
  status: ArticleStatus;
  isOfficial: boolean;
  tags: {
    tag: {
      id: number;
      name: string;
      isCategory: boolean;
    };
  }[];
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
    profilePictureId?: number | null;
  };
  userCosmetics: {
    data: Prisma.JsonValue;
    cosmetic: {
      data: Prisma.JsonValue;
      type: CosmeticType;
      id: number;
      name: string;
      source: CosmeticSource;
    };
  }[];
  cosmetic?: ContentDecorationCosmetic | null;
};

const getArticleStatsObject = async (data: { id: number }[]) => {
  try {
    return await articleStatCache.fetch(data.map((d) => d.id));
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to getArticleStats',
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'article-stats'
    ).catch();
    return {};
  }
};

export type ArticleGetAllRecord = Awaited<ReturnType<typeof getArticles>>['items'][number];

export type ArticleGetAll = AsyncReturnType<typeof getArticles>['items'];
export const getArticles = async ({
  limit,
  cursor,
  query,
  tags,
  period,
  periodMode,
  sort,
  sessionUser,
  excludedIds,
  excludedUserIds,
  excludedTagIds,
  userIds,
  favorites,
  hidden,
  username,
  includeDrafts,
  ids,
  collectionId,
  followed,
  pending,
  browsingLevel,
  include,
  forceHidePrivate,
  eventDecorationViewer,
}: GetInfiniteArticlesSchema & {
  sessionUser?: { id: number; isModerator?: boolean; username?: string };
  include?: Array<'cosmetics'>;
  // Who sees event decorations before launch (see getEventDecorationsForEntity). Set only by
  // routes whose response is never cached for another viewer.
  eventDecorationViewer?: EventViewer;
  // When true, `availability = Private` articles are ALWAYS dropped, even when a
  // `username`/`collectionId`/etc. filter is set (which normally expands the result
  // set to include the caller's private articles). Used by the public REST surface
  // so an anonymous `?username=X` request can never surface a user's private
  // articles. Defaults to false → the website/tRPC path is unchanged.
  forceHidePrivate?: boolean;
}) => {
  const userId = sessionUser?.id;
  const isModerator = sessionUser?.isModerator ?? false;
  const includeCosmetics = !!include?.includes('cosmetics');
  try {
    const take = limit + 1;
    const isMod = sessionUser?.isModerator ?? false;
    let isOwnerRequest = false;
    const hidePrivateArticles =
      forceHidePrivate ||
      (!ids && !username && !collectionId && !followed && !hidden && !favorites && !userIds);

    const AND: Prisma.Sql[] = [];
    let collectionJoin = Prisma.empty;

    if (sort === ArticleSort.RecentlyAdded && !collectionId) {
      throw throwBadRequestError('Recently Added sort requires a collectionId');
    }

    if (query) {
      AND.push(Prisma.sql`a."title" ILIKE ${'%' + query + '%'}`);
    }
    if (!!tags?.length) {
      AND.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM "TagsOnArticle" toa WHERE toa."articleId" = a.id AND toa."tagId" IN (${Prisma.join(
            tags,
            ','
          )})
        )`
      );
    }

    if (!!userIds?.length) {
      AND.push(Prisma.sql`a."userId" IN (${Prisma.join(userIds, ',')})`);
    }
    if (!!ids?.length) {
      AND.push(Prisma.sql`a.id IN (${Prisma.join(ids, ',')})`);
    }

    if (browsingLevel) {
      if (pending && (isModerator || userId)) {
        if (isModerator) {
          AND.push(Prisma.sql`((a."nsfwLevel" & ${browsingLevel}) != 0 OR a."nsfwLevel" = 0)`);
        } else if (userId) {
          AND.push(
            Prisma.sql`((a."nsfwLevel" & ${browsingLevel}) != 0 OR (a."nsfwLevel" = 0 AND a."userId" = ${userId}))`
          );
        }
      } else {
        AND.push(Prisma.sql`(a."nsfwLevel" & ${browsingLevel}) != 0`);
      }
    }

    if (username) {
      const userFindArgs = { where: { username: username ?? '' }, select: { id: true } };
      const targetUser =
        (await dbRead.user.findUnique(userFindArgs)) ??
        (await dbWrite.user.findUnique(userFindArgs));

      if (!targetUser) throw throwNotFoundError('User not found');

      isOwnerRequest = !!userId && targetUser.id === userId;
      AND.push(Prisma.sql`u.id = ${targetUser.id}`);
    }

    if (collectionId) {
      const permissions = await getUserCollectionPermissionsById({
        userId: sessionUser?.id,
        id: collectionId,
      });

      if (!permissions.read) {
        return { items: [] };
      }

      const { rawAND: collectionItemModelsRawAND } = getAvailableCollectionItemsFilterForUser({
        permissions,
        userId: sessionUser?.id,
      });

      // A semi-join cannot expose ci."id" to the ORDER BY. Safe to widen: CollectionItem_article_idx
      // is unique on ("collectionId", "articleId"), so the join cannot multiply rows.
      // schema.full.prisma does not declare it — see containers/db/docker-init/02_all_dll.sql.
      if (sort === ArticleSort.RecentlyAdded) {
        collectionJoin = Prisma.sql`JOIN "CollectionItem" ci ON ci."articleId" = a."id"
          AND ci."collectionId" = ${collectionId}
          AND ${Prisma.join(collectionItemModelsRawAND, ' AND ')}`;
      } else {
        AND.push(
          Prisma.sql`EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."articleId" = a."id"
        AND ci."collectionId" = ${collectionId}
        AND ${Prisma.join(collectionItemModelsRawAND, ' AND ')})`
        );
      }
    }

    if (!isOwnerRequest) {
      if (!isMod) {
        AND.push(Prisma.sql`a."status" = ${ArticleStatus.Published}::"ArticleStatus"`);
        if (userId) {
          AND.push(
            Prisma.sql`(a."ingestion" = 'Scanned'::"ArticleIngestionStatus" OR a."userId" = ${userId})`
          );
        } else {
          AND.push(Prisma.sql`a."ingestion" = 'Scanned'::"ArticleIngestionStatus"`);
        }
      }
      if (!!excludedUserIds?.length) {
        AND.push(Prisma.sql`a."userId" != ALL(${excludedUserIds}::int[])`);
      }
      if (!!excludedIds?.length) {
        AND.push(Prisma.sql`a.id NOT IN (${Prisma.join(excludedIds, ',')})`);
      }
      if (!!excludedTagIds?.length) {
        AND.push(
          Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "TagsOnArticle" toa WHERE toa."articleId" = a.id AND toa."tagId" IN (${Prisma.join(
              excludedTagIds,
              ','
            )})
          )`
        );
      }
    }

    if (sessionUser) {
      if (favorites) {
        AND.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "ArticleEngagement" ae WHERE ae."articleId" = a.id AND ae."userId" = ${sessionUser?.id} AND ae."type" = ${ArticleEngagementType.Favorite}::"ArticleEngagementType"
          )`
        );
      } else if (hidden) {
        AND.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "ArticleEngagement" ae WHERE ae."articleId" = a.id AND ae."userId" = ${sessionUser?.id} AND ae."type" = ${ArticleEngagementType.Hide}::"ArticleEngagementType"
          )`
        );
      }
    }

    // Filter only followed users
    if (!!sessionUser && followed) {
      const followedUsers = await dbRead.user.findUnique({
        where: { id: sessionUser.id },
        select: {
          engagingUsers: {
            select: { targetUser: { select: { id: true } } },
            where: { type: 'Follow' },
          },
        },
      });
      const followedUsersIds =
        followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];

      AND.push(Prisma.sql`a."userId" IN (${Prisma.join(followedUsersIds, ',')})`);
    }

    const publishedAtFilter: Prisma.Sql | undefined =
      isMod && includeDrafts
        ? undefined
        : period !== MetricTimeframe.AllTime && periodMode !== 'stats'
        ? Prisma.sql`a."publishedAt" >= ${decreaseDate(
            new Date(),
            1,
            period.toLowerCase() as ManipulateType
          )}`
        : Prisma.sql`a."publishedAt" IS NOT NULL AND a.status = 'Published'::"ArticleStatus"`;

    if (publishedAtFilter) {
      AND.push(publishedAtFilter);
    }

    // --- Sort & keyset-pagination setup ---
    //
    // `sortExpr` resolves to a non-NULL numeric value: rank columns come from a
    // LEFT JOIN on "ArticleRank" and are NULL for articles with no ranking
    // in the current period (the common case for recently-ingested articles),
    // so we coalesce to INT_MAX so they sort last under ASC instead of
    // terminating the cursor (`nextCursor` used to become `undefined` the
    // moment a page's last row had a NULL rank → feed stopped after page 1).
    //
    // Pagination is a keyset on (sortExpr, a.id DESC). `a.id` is the
    // tiebreaker so pages are deterministic even when many articles share
    // the same sort value (e.g. the INT_MAX sentinel).
    const NULL_RANK_SENTINEL = 2147483647; // max int32 — sorts after any real rank under ASC
    const rankExpr = (col: string) => `COALESCE(rank."${col}${period}Rank", ${NULL_RANK_SENTINEL})`;

    let sortExpr: string;
    let sortDir: 'ASC' | 'DESC';
    switch (sort) {
      case ArticleSort.MostBookmarks:
      case ArticleSort.MostCollected:
        sortExpr = rankExpr('collectedCount');
        sortDir = 'ASC';
        break;
      case ArticleSort.MostComments:
        sortExpr = rankExpr('commentCount');
        sortDir = 'ASC';
        break;
      case ArticleSort.MostReactions:
        sortExpr = rankExpr('reactionCount');
        sortDir = 'ASC';
        break;
      case ArticleSort.RecentlyUpdated:
        sortExpr = `extract(epoch from a."updatedAt")`;
        sortDir = 'DESC';
        break;
      case ArticleSort.RecentlyAdded:
        sortExpr = `ci."id"`;
        sortDir = 'DESC';
        break;
      case ArticleSort.Newest:
      default:
        sortExpr = `extract(epoch from a."publishedAt")`;
        sortDir = 'DESC';
        break;
    }

    const sortExprSql = Prisma.raw(sortExpr);
    const orderBy = Prisma.sql`${sortExprSql} ${Prisma.raw(sortDir)}, a.id DESC`;

    if (cursor) {
      // Keyset predicate: include the cursor row itself — it's the lookahead
      // row from the previous page, intended to anchor this page. Tiebreaker
      // is always id DESC, so on a sortExpr tie we accept ids <= cursor.id
      // (rows with id > cursor.id were already returned on the previous page).
      const primaryOp = Prisma.raw(sortDir === 'DESC' ? '<' : '>');
      AND.push(Prisma.sql`(
        ${sortExprSql} ${primaryOp} ${cursor.v}
        OR (${sortExprSql} = ${cursor.v} AND a.id <= ${cursor.id})
      )`);
    }

    const queryFrom = Prisma.sql`
      FROM "Article" a
      LEFT JOIN "User" u ON a."userId" = u.id
      LEFT JOIN "ArticleRank" rank ON rank."articleId" = a.id
      ${collectionJoin}
      WHERE ${Prisma.join(AND, ' AND ')}
    `;
    const articles = await dbRead.$queryRaw<(ArticleRaw & { cursorV: number })[]>`
      SELECT
        a.id,
        a.cover,
        a."coverId",
        a.title,
        a."publishedAt",
        a."nsfwLevel",
        a."userNsfwLevel",
        a."userId",
        a."createdAt",
        a."updatedAt",
        a."unlisted",
        a."availability",
        a."userId",
        a.status,
        a."isOfficial",
        (
          SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object('tag', jsonb_build_object(
                  'id', t.id,
                  'name', t.name,
                  'isCategory', t."isCategory"
                ))
            ), '[]'::jsonb
          ) FROM "TagsOnArticle" at
            JOIN "Tag" t ON t.id = at."tagId"
            WHERE at."articleId" = a."id"
            AND "tagId" IS NOT NULL
        ) as "tags",
        jsonb_build_object(
          'id', u."id",
          'username', u."username",
          'deletedAt', u."deletedAt",
          'image', u."image",
          'profilePictureId', u."profilePictureId"
        ) as "user",
        (
          SELECT
            jsonb_agg(
              jsonb_build_object(
                'data', uc.data,
                'cosmetic', jsonb_build_object(
                  'id', c.id,
                  'data', c.data,
                  'type', c.type,
                  'source', c.source,
                  'name', c.name,
                  'leaderboardId', c."leaderboardId",
                  'leaderboardPosition', c."leaderboardPosition"
                )
              )
            )
          FROM "UserCosmetic" uc
          JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
              AND "equippedAt" IS NOT NULL
          WHERE uc."userId" = a."userId" AND uc."equippedToId" IS NULL
          GROUP BY uc."userId"
        ) as "userCosmetics",
        ${sortExprSql} as "cursorV"
      ${queryFrom}
      ORDER BY ${orderBy}
      LIMIT ${take}
    `;

    let nextCursor: ArticleCursor | undefined;
    if (articles.length > limit) {
      const nextItem = articles.pop();
      if (nextItem) nextCursor = { v: Number(nextItem.cursorV), id: nextItem.id };
    }

    const profilePictures = await dbRead.image.findMany({
      where: { id: { in: articles.map((a) => a.user.profilePictureId).filter(isDefined) } },
      select: { ...profileImageSelect, ingestion: true },
    });

    const coverIds = articles.map((x) => x.coverId).filter(isDefined);
    const coverImages = coverIds.length
      ? await dbRead.image.findMany({
          where: { id: { in: coverIds } },
          select: imageSelect,
        })
      : [];

    const articleCategories = await getCategoryTags('article');
    const [cosmetics, eventDecorations] = includeCosmetics
      ? await Promise.all([
          getCosmeticsForEntity({ ids: articles.map((x) => x.id), entity: 'Article' }),
          getEventDecorationsForEntity({
            ids: articles.map((x) => x.id),
            entity: 'Article',
            viewer: eventDecorationViewer,
          }),
        ])
      : [{}, {}];

    // Fetch article stats separately
    const articleStats = await getArticleStatsObject(articles);

    const items = articles
      .filter((a) => {
        // This take prio over mod status just so mods can see the same as users.
        if (hidePrivateArticles && a.availability === Availability.Private) return false;
        if (sessionUser?.isModerator || a.userId === sessionUser?.id) return true;

        return true;
      })
      .map(({ tags, user, userCosmetics, cursorV, ...article }) => {
        const { profilePictureId, ...u } = user;
        const profilePicture = profilePictures.find((p) => p.id === profilePictureId) ?? null;
        const coverImage = coverImages.find((x) => x.id === article.coverId);
        const match = articleStats[article.id];

        return {
          ...article,
          tags: tags.map(({ tag }) => ({
            ...tag,
            isCategory: articleCategories.some((c) => c.id === tag.id),
          })),
          stats: match
            ? {
                favoriteCount: match.favoriteCount ?? 0,
                collectedCount: match.collectedCount ?? 0,
                commentCount: match.commentCount ?? 0,
                likeCount: match.likeCount ?? 0,
                dislikeCount: match.dislikeCount ?? 0,
                heartCount: match.heartCount ?? 0,
                laughCount: match.laughCount ?? 0,
                cryCount: match.cryCount ?? 0,
                viewCount: match.viewCount ?? 0,
                tippedAmountCount: match.tippedAmountCount ?? 0,
              }
            : undefined,
          user: {
            ...u,
            profilePicture,
            cosmetics: userCosmetics,
          },
          coverImage: coverImage
            ? {
                ...coverImage,
                // Lift the cover image nsfwLevel to the article's aggregate so card-level NSFW filtering (ImageGuard blur, browsingLevel mask) reflects content images or userNsfwLevel that may have raised the rating above the cover's own level.
                nsfwLevel: Math.max(article.nsfwLevel ?? 0, coverImage.nsfwLevel ?? 0),
                meta: coverImage.meta as ImageMetaProps,
                metadata: coverImage.metadata as ImageMetadata,
                tags: coverImage?.tags.flatMap((x) => x.tag.id),
              }
            : undefined,
          cosmetic: cosmetics[article.id] ?? null,
          eventDecoration: eventDecorations[article.id] ?? null,
        };
      });

    return {
      nextCursor,
      items: items as Array<
        Omit<(typeof items)[number], 'cosmetic' | 'eventDecoration'> & {
          cosmetic?: ContentDecorationCosmetic | null;
          eventDecoration?: EventDecorationCosmetic | null;
        }
      >,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

type CivitaiNewsItemRaw = {
  id: number;
  collection: string;
  coverId?: number;
  title: string;
  content: string;
  publishedAt: Date;
  userId: number;
  featured: boolean;
  summary?: string;
};
export type CivitaiNewsItem = AsyncReturnType<typeof getCivitaiNews>['articles'][number];
export const getCivitaiNews = async () => {
  const articlesRaw = await dbRead.$queryRaw<CivitaiNewsItemRaw[]>`
    SELECT
      c.name as "collection",
      a.id,
      "coverId",
      title,
      content,
      "publishedAt",
      a."userId",
      COALESCE(a.metadata->>'featured' = 'true', false) AS featured,
      a.metadata->>'summary' AS summary
    FROM "Article" a
    JOIN "CollectionItem" ci ON ci."articleId" = a.id
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE c.name IN ('Newsroom', 'Updates') AND c."userId" = -1 AND a."createdAt" > now() - '1 year'::interval
      AND a."publishedAt" IS NOT NULL AND a.status = 'Published'::"ArticleStatus"
      AND a."ingestion" = 'Scanned'::"ArticleIngestionStatus"
      AND (a."nsfwLevel" & ${publicBrowsingLevelsFlag}) != 0
    ORDER BY a."createdAt" DESC
    LIMIT 10
  `;
  const userIds = new Set(articlesRaw.map((x) => x.userId));
  const users = await dbRead.user.findMany({
    where: { id: { in: [...userIds] } },
    select: userWithCosmeticsSelect,
  });

  const coverIds = articlesRaw.map((x) => x.coverId).filter(isDefined);
  const coverImages = coverIds.length
    ? await dbRead.image.findMany({
        where: { id: { in: coverIds } },
        select: imageSelect,
      })
    : [];

  const articles = articlesRaw.map((article) => {
    const user = users.find((x) => x.id === article.userId);
    const coverImage = coverImages.find((x) => x.id === article.coverId);
    return {
      ...article,
      user: user ?? null,
      summary: article.summary ?? truncate(removeTags(article.content), { length: 200 }),
      coverImage: coverImage
        ? { ...coverImage, tags: coverImage?.tags.flatMap((x) => x.tag.id) }
        : undefined,
      type: article.collection === 'Newsroom' ? 'news' : 'updates',
    };
  });

  const pressMentions = await dbRead.pressMention.findMany({
    orderBy: { publishedAt: 'desc' },
    where: { publishedAt: { lte: new Date() } },
  });

  return { articles, pressMentions };
};

/**
 * Ingestion state of an article that is published for everyone, or null if it is not published at
 * all. Callers apply their own policy to it — the two that exist disagree, deliberately.
 *
 * `getArticleById` additionally requires `ingestion = Scanned` for non-owners, so a published
 * article throws NOT_FOUND to the public until its images finish scanning. An edit to a live
 * article re-enters that window (upsert sets `Rescan`), so it is not publish-only.
 *
 * SSR asks "could this ever render?" and holds its 200 for anything that might still resolve,
 * because a 404 on an indexed URL is not a state to enter transiently. The viewer-facing
 * procedure asks the narrower "is it resolving right now?" — `Error` may recover on a retry but
 * has no bounded wait to promise a reader, and `Blocked` never resolves.
 */
export const getPublishedArticleIngestion = async (
  id: number
): Promise<ArticleIngestionStatus | null> => {
  const db = await getDbWithoutLag('article', id);
  const article = await db.article.findFirst({
    where: { id, publishedAt: { not: null }, status: ArticleStatus.Published },
    select: { ingestion: true },
  });

  return article?.ingestion ?? null;
};

/** Is the article inside the transient scan window that hides it from non-owners? */
export const isArticleProcessing = async ({ id }: GetByIdInput) => {
  const ingestion = await getPublishedArticleIngestion(id);
  return (
    ingestion === ArticleIngestionStatus.Pending || ingestion === ArticleIngestionStatus.Rescan
  );
};

export type ArticleGetById = AsyncReturnType<typeof getArticleById>;
export const getArticleById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  try {
    const db = await getDbWithoutLag('article', id);
    const article = await db.article.findFirst({
      where: {
        id,
        OR: !isModerator
          ? [
              {
                publishedAt: { not: null },
                status: ArticleStatus.Published,
                ingestion: ArticleIngestionStatus.Scanned,
              },
              { userId },
            ]
          : undefined,
      },
      // Include `moderatorNsfwLevel` here (not in the shared select) so the
      // edit form can render the override banner / picker. The public article
      // read payload is served by `getArticles`, not this function, so the
      // field doesn't flow into external webhook / search-index payloads.
      select: {
        ...articleDetailSelect,
        moderatorNsfwLevel: true,
        scheduledAt: true,
        reactions: viewerReactionsSelect(userId),
      },
    });

    if (!article) throw throwNotFoundError(`No article with id ${id}`);
    if (userId && !isModerator) {
      const blocked = await amIBlockedByUser({ userId, targetUserId: article.userId });
      if (blocked) throw throwNotFoundError(`No article with id ${id}`);
    }

    // Fetch connected images with ingestion status
    const imageConnections = await dbRead.imageConnection.findMany({
      where: { entityId: id, entityType: ImageConnectionType.Article },
      include: {
        image: {
          select: { id: true, url: true, ingestion: true },
        },
      },
    });

    const articleCategories = await getCategoryTags('article');
    const attachments: Awaited<ReturnType<typeof getFilesByEntity>> = await getFilesByEntity({
      id,
      type: 'Article',
    });

    const coverImage = article.coverImage
      ? {
          ...article.coverImage,
          nsfwLevel: article.coverImage.nsfwLevel as NsfwLevel,
          meta: article.coverImage.meta as ImageMetaProps,
          metadata: article.coverImage.metadata as ImageMetadata,
          tags: article.coverImage?.tags.flatMap((x) => x.tag.id),
        }
      : undefined;

    const canViewCoverImage =
      isModerator ||
      userId === article.userId ||
      (coverImage?.ingestion === 'Scanned' && !coverImage?.needsReview);

    // `content` is always sanitized HTML — the editor only ever emits `editor.getHTML()`.
    // Never parse it as JSON: sanitize-html passes a JSON body through untouched, so that
    // branch let any author store a doc with node types the renderer has no schema entry for
    // (blank page for every reader) or malformed JSON (500 → NotFound for everyone, owner
    // included). `generateJSON` is total over arbitrary text.
    let contentJson: MixedObject | undefined;
    if (article.content) {
      contentJson = generateJSON(article.content, tiptapExtensions);
    }

    return {
      ...article,
      nsfwLevel: article.nsfwLevel as NsfwLevel,
      attachments,
      tags: article.tags.map(({ tag }) => ({
        ...tag,
        isCategory: articleCategories.some((c) => c.id === tag.id),
      })),
      coverImage: canViewCoverImage ? coverImage : undefined,
      contentJson,
      contentImages: imageConnections.map((conn) => conn.image),
      metadata: (article.metadata as ArticleMetadata) ?? null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

const ARTICLE_VIOLATION_STATUS_LOCKED_MESSAGE =
  'This article was unpublished for violating Terms of Service and its status cannot be changed. Please contact support if you believe this was in error.';

export const upsertArticle = async ({
  id,
  userId,
  tags: inputTags,
  attachments,
  coverImage,
  isModerator,
  scanContent,
  scheduledAt,
  ...data
}: UpsertArticleInput & {
  userId: number;
  isModerator?: boolean;
  metadata?: ArticleMetadata;
  scanContent?: boolean;
}) => {
  // Set only while the guarded draft write below is in flight, so its P2025 is told apart.
  let writingNeverPublishedDraft = false;
  let writingWithoutViolationStatus = false;
  try {
    const officialTag = await getOfficialArticleTag();
    const tags = withoutOfficialArticleTag(inputTags, officialTag);
    await throwOnBlockedUserContent(
      [data.title, data.content, ...(await newTagNames(tags?.map((tag) => tag.name)))],
      { isModerator, surface: 'article' }
    );

    // For updates, fetch article early so we can enforce its stored locks and check cover
    // image ownership and NSFW level
    let article: {
      id: number;
      title: string;
      cover: string | null;
      coverId: number | null;
      userId: number;
      publishedAt: Date | null;
      status: string;
      nsfwLevel: number;
      userNsfwLevel: number;
      moderatorNsfwLevel: number | null;
      lockedProperties: string[];
      metadata: Prisma.JsonValue;
      content: string | null;
    } | null = null;
    if (id) {
      article = await dbWrite.article.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          cover: true,
          coverId: true,
          userId: true,
          publishedAt: true,
          status: true,
          nsfwLevel: true,
          userNsfwLevel: true,
          moderatorNsfwLevel: true,
          lockedProperties: true,
          metadata: true,
          content: true,
        },
      });
      if (!article) throw throwNotFoundError();
      const isOwner = article.userId === userId || isModerator;
      if (!isOwner) throw throwAuthorizationError('You cannot perform this action');
    }

    if (data.content) {
      await assertArticleContentUrlsUsable({
        content: data.content,
        storedContent: article?.content,
        userId,
        ownerId: article?.userId ?? userId,
      });
    }

    enforceLockedProperties({
      data,
      storedLockedProperties: article?.lockedProperties,
      isModerator,
    });

    // Scheduling stays a plain Draft (publishedAt NULL). Publishing now, or an explicit null, clears
    // the schedule.
    const scheduling = !!scheduledAt;
    let scheduledAtWrite: Date | null | undefined;
    if (scheduledAt) {
      const scheduleError = getArticleScheduleError(article, scheduledAt, new Date());
      if (scheduleError) throw throwBadRequestError(scheduleError);
      data.status = ArticleStatus.Draft;
      scheduledAtWrite = scheduledAt;
    } else if (
      scheduledAt === null ||
      data.status === ArticleStatus.Published ||
      data.status === ArticleStatus.Processing
    ) {
      scheduledAtWrite = null;
    }
    if (!isModerator) {
      // moderatorNsfwLevel is a mod-only field. Silently strip it from
      // non-moderator payloads rather than throwing: the form never exposes
      // this control to owners, so a client sending it indicates either a
      // stale client or an attempt to forge the override — either way, drop.
      delete data.moderatorNsfwLevel;
    }

    // Re-expanded from the owner's rows rather than trusted from the client, and before
    // the write so what is stored is what the blurb actually says. Keyed on the OWNER,
    // not the actor: a moderator saving someone else's article resolves none of their
    // blurbs and would strip every span.
    const restrictToBlurbIds =
      article && article.userId !== userId
        ? () => getReferencedBlurbIds({ entityType: 'Article', entityId: article.id })
        : undefined;
    const expansion = await expandBlurbs({
      userId: article?.userId ?? userId,
      html: data.content,
      restrictToBlurbIds,
    });
    data.content = expansion.html;

    // The guard at the top of this function saw the CLIENT's html. Blurb bodies were
    // spliced in above, so the string about to be written is one it never checked.
    await throwOnBlockedUserContent(data.content, { isModerator, surface: 'article' });
    await assertNoShopArtworkInContent(data.content, article?.content);

    // TODO make coverImage required here and in db
    // create image entity to be attached to article
    // Stays `undefined` when there is no cover — Prisma reads that as "don't write this
    // column". (It was previously seeded from `coverImage?.id`, which is dead: the only branch
    // in which that could be non-undefined is the one that immediately overwrites it.)
    let coverId: number | undefined;
    if (coverImage) {
      // `id` present -> the ownership rule below runs, unchanged. `id` absent -> reuse an
      // existing row for this url, else verify the object is still in the uploads bucket
      // before minting a row (a stale client draft can replay a key whose object is gone).
      coverId = await resolveCoverImageId({
        coverImage,
        userId,
        currentCoverId: article?.coverId,
        assertOwnership: async (imageId) => {
          // Skip ownership check when the cover image hasn't changed (e.g. mod-uploaded covers)
          const isExistingCover = article != null && imageId === article.coverId;
          if (!isExistingCover) {
            const isImgOwner = await isImageOwner({ userId, isModerator, imageId });
            if (!isImgOwner) {
              throw throwAuthorizationError('Invalid cover image');
            }
          }
        },
      });
    }

    if (!id) {
      // Set publishedAt based on status
      // - Published: Set to now (appears at top of feed)
      // - Processing: Don't set yet (will be set when scan completes)
      // - Draft/Other: Don't set
      let publishedAt: Date | null | undefined = undefined;
      if (data.status === ArticleStatus.Published) {
        publishedAt = new Date();
      } else if (data.status === ArticleStatus.Processing) {
        publishedAt = null;
      }

      const result = await dbWrite.$transaction(async (tx) => {
        const article = await tx.article.create({
          data: {
            ...data,
            publishedAt,
            scheduledAt: scheduledAtWrite,
            coverId,
            userId,
            tags: tags
              ? {
                  create: tags.map((tag) => {
                    const name = tag.name.toLowerCase().trim();
                    return {
                      tag: {
                        connectOrCreate: {
                          where: { name },
                          create: { name, target: [TagTarget.Article] },
                        },
                      },
                    };
                  }),
                }
              : undefined,
          },
        });
        if (article.isOfficial && officialTag)
          await writeOfficialArticleTag({
            articleId: article.id,
            tagId: officialTag.id,
            isOfficial: true,
            db: tx,
          });

        if (attachments) {
          await tx.file.createMany({
            data: attachments.map((attachment) => ({
              ...attachment,
              entityId: article.id,
              entityType: 'Article',
            })),
          });
        }

        if (expansion.evaluated)
          await reconcileBlurbReferences({
            entityType: 'Article',
            entityId: article.id,
            uses: expansion.uses,
            tx,
          });

        return article;
      });

      // Count-cache refresh hits Redis — run after commit, off the txn budget.
      await userArticleCountCache.refresh(result.userId);

      await preventReplicationLag('article', result.id);
      await preventReplicationLag('userArticles', userId);

      // Link content images for new article (creates Image entities and ImageConnections)
      if (result.content && scanContent) {
        try {
          await linkArticleContentImages({
            articleId: result.id,
            content: result.content,
            userId,
            ownerId: result.userId,
            coverId: result.coverId,
          });

          // Mark scan as requested after successfully linking images
          await dbWrite.article.update({
            where: { id: result.id },
            data: { scanRequestedAt: new Date(), ingestion: ArticleIngestionStatus.Pending },
          });
        } catch (e) {
          // Non-blocking: continue even if image linking fails, but log the error
          const error = e as Error;
          logToAxiom({
            type: 'error',
            name: 'article-image-linking',
            message: error.message,
            cause: error.cause,
            stack: error.stack,
            articleId: result.id,
          }).catch();
        }
      }

      // Submit for text moderation (non-blocking, fire-and-forget)
      if (result.content && isPublicArticle(result)) {
        const textForModeration = [data.title, removeTags(result.content)]
          .filter(Boolean)
          .join(' ');
        submitTextModerationOrScan({
          entityType: 'Article',
          entityId: result.id,
          xguard: () =>
            submitTextModeration({
              entityType: 'Article',
              entityId: result.id,
              content: textForModeration,
              labels: ['nsfw'],
              recordForReview: true,
              rearmRetries: true,
            }),
        }).catch((e) => {
          logToAxiom({
            type: 'error',
            name: 'article-text-moderation',
            message: (e as Error).message,
            articleId: result.id,
          }).catch();
        });
      }

      return result;
    }

    // article is guaranteed non-null here since the `if (id)` block above fetches it
    if (!article) throw throwNotFoundError();

    // userNsfwLevel is the user's preference and is preserved verbatim. The
    // effective article.nsfwLevel is derived by updateArticleNsfwLevels as
    // GREATEST(userNsfwLevel, cover, content images, moderation floor), so
    // writing a lower userNsfwLevel cannot leak content past filters — the
    // higher signals keep nsfwLevel raised. When those signals later drop
    // (images removed, moderation unactioned), nsfwLevel falls back to the
    // user's original choice instead of being permanently anchored by a
    // prior clamp.

    if (
      !isModerator &&
      article.status === ArticleStatus.UnpublishedViolation &&
      data.status &&
      data.status !== article.status
    ) {
      throw throwBadRequestError(ARTICLE_VIOLATION_STATUS_LOCKED_MESSAGE);
    }

    // SECURITY: Validate image scan status before allowing publish
    // Prevent publishing articles with blocked or failed images
    // Note: Pending images are allowed - article will remain in Processing status until scan completes
    // Scheduling is a publish decided now, so it is refused on the same images.
    if (!isModerator && (data.status === ArticleStatus.Published || scheduling) && scanContent) {
      const scanStatus = await getArticleScanStatus({ id });
      const hasProblematicImages = scanStatus.blocked > 0 || scanStatus.error > 0;

      if (hasProblematicImages) {
        const errorParts: string[] = [];
        if (scanStatus.blocked > 0) {
          errorParts.push(`${scanStatus.blocked} image(s) blocked (policy violation)`);
        }
        if (scanStatus.error > 0) {
          errorParts.push(`${scanStatus.error} image(s) failed to scan`);
        }

        throw throwBadRequestError(
          `Cannot publish article: ${errorParts.join(', ')}. Please remove or replace these images.`
        );
      }
    }

    // moderatorNsfwLevel is the mod override layer that takes precedence over
    // the GREATEST derivation (see updateArticleNsfwLevels). We still need to
    // know when the override changed so the locked-properties set below can
    // pin/unpin userNsfwLevel accordingly — the recompute itself happens
    // unconditionally via updateArticleImageScanStatus post-commit.
    const moderatorOverrideChanged =
      !!isModerator &&
      data.moderatorNsfwLevel !== undefined &&
      data.moderatorNsfwLevel !== article.moderatorNsfwLevel;

    // When a mod sets an override, lock the user's picker so a subsequent
    // owner save can't quietly drift userNsfwLevel underneath it. When the
    // mod clears the override (sets back to null) we unlock the picker and
    // the article returns to auto-derivation on the next recompute. Lock/unlock
    // fires only when the override VALUE changes; the basis snapshot below has
    // its own (broader) trigger.
    let moderatorNsfwLevelBasis: number | null | undefined = undefined;
    if (moderatorOverrideChanged) {
      const lockedSet = new Set<string>(data.lockedProperties ?? article.lockedProperties ?? []);
      if (data.moderatorNsfwLevel != null) lockedSet.add('userNsfwLevel');
      else lockedSet.delete('userNsfwLevel');
      data.lockedProperties = Array.from(lockedSet);
    }
    // (Re)snapshot `moderatorNsfwLevelBasis` — the content-derived level at
    // override time — so the auto-approve gate (#6) can later distinguish a
    // genuine content drop from an override deliberately set above the images
    // (which must not be auto-cleared by an owner dispute). Re-stamp on every
    // moderator assertion of a non-null override (even an unchanged re-affirm),
    // clear it when the override is cleared, and leave it untouched when the
    // field is omitted. NOTE: derived is computed against the CURRENTLY-COMMITTED
    // content — if this same save also changes images, those rescan post-commit,
    // so the basis reflects pre-save content (safe: gate #3 blocks auto-approve
    // until the rescan settles). See shouldRestampOverrideBasis for why
    // aggressive re-stamping is safe.
    if (!!isModerator && data.moderatorNsfwLevel === null) {
      moderatorNsfwLevelBasis = null;
    } else if (
      shouldRestampOverrideBasis({
        isModerator: !!isModerator,
        payloadOverride: data.moderatorNsfwLevel,
        currentOverride: article.moderatorNsfwLevel,
      })
    ) {
      moderatorNsfwLevelBasis = (await computeArticleDerivedNsfwLevel(id as number)) ?? 0;
    }

    const republishing =
      (article.status === ArticleStatus.Unpublished && data.status === ArticleStatus.Published) ||
      !!article.publishedAt;

    const prevMetadata = article.metadata as ArticleMetadata | null;

    // Set publishedAt based on status
    // - Published: Set to now for new articles, preserve for republishing
    // - Processing: Preserve existing publishedAt if article was already published (re-scan scenario)
    // - Unpublished: Preserve publishedAt so republish keeps original date
    // - Draft: Preserve publishedAt — once an article has gone public,
    //   demoting it back to Draft must not erase the original publish date.
    //   Otherwise the next republish satisfies `republishing = !!article.publishedAt === false`
    //   and gets a fresh `new Date()`, surfacing old content at the top of
    //   the Newest feed. Only legitimately never-published rows keep
    //   publishedAt = null (it was already null on read; `article.publishedAt`
    //   passes that through unchanged).
    let publishedAt: Date | null | undefined = undefined;
    if (data.status === ArticleStatus.Published) {
      publishedAt = republishing ? article.publishedAt : new Date();
    } else if (data.status === ArticleStatus.Processing) {
      // Preserve original publishedAt if article was already published (re-scanning scenario)
      // Otherwise set to null for new articles
      publishedAt = article.publishedAt || null;
    } else if (data.status === ArticleStatus.Unpublished) {
      // Preserve publishedAt when unpublishing so republish keeps original date
      publishedAt = article.publishedAt;
    } else if (data.status === ArticleStatus.Draft) {
      publishedAt = article.publishedAt;
    }

    // Guarded: the job may have taken this draft live since the read, and an unguarded write would
    // revert it to Draft and re-fire the go-live side effects on the next publish.
    writingNeverPublishedDraft = article.status === ArticleStatus.Draft && !article.publishedAt;
    // A removal landing between the read and this write must not be overwritten by the owner.
    writingWithoutViolationStatus =
      !writingNeverPublishedDraft &&
      !isModerator &&
      article.status !== ArticleStatus.UnpublishedViolation;
    const updateWhere: Prisma.ArticleWhereUniqueInput = writingNeverPublishedDraft
      ? { id, status: ArticleStatus.Draft, publishedAt: null }
      : writingWithoutViolationStatus
      ? { id, status: { not: ArticleStatus.UnpublishedViolation } }
      : { id };
    const result = await dbWrite.$transaction(async (tx) => {
      const updated = await tx.article.update({
        where: updateWhere,
        data: {
          ...data,
          ...(moderatorNsfwLevelBasis !== undefined ? { moderatorNsfwLevelBasis } : {}),
          metadata: { ...prevMetadata, ...data.metadata },
          publishedAt,
          scheduledAt: scheduledAtWrite,
          coverId,
          tags: tags
            ? {
                deleteMany: {
                  tagId: {
                    notIn: tags.filter(isTag).map((x) => x.id),
                  },
                },
                connectOrCreate: tags.filter(isTag).map((tag) => ({
                  where: { tagId_articleId: { tagId: tag.id, articleId: id as number } },
                  create: { tagId: tag.id },
                })),
                create: tags.filter(isNotTag).map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Article] },
                      },
                    },
                  };
                }),
              }
            : undefined,
        },
      });
      if (!updated) return null;
      // A tag rewrite above drops the official row like any other; the column restores it.
      if (officialTag && (tags || data.isOfficial !== undefined))
        await writeOfficialArticleTag({
          articleId: updated.id,
          tagId: officialTag.id,
          isOfficial: updated.isOfficial,
          db: tx,
        });

      if (attachments) {
        // Delete any attachments that were removed.
        await tx.file.deleteMany({
          where: {
            entityId: id,
            entityType: 'Article',
            id: { notIn: attachments.map((x) => x.id).filter(isDefined) },
          },
        });

        // Create any new attachments.
        await tx.file.createMany({
          data: attachments
            .filter((x) => !x.id)
            .map((attachment) => ({
              ...attachment,
              entityId: updated.id,
              entityType: 'Article',
            })),
        });
      }

      if (expansion.evaluated)
        await reconcileBlurbReferences({
          entityType: 'Article',
          entityId: updated.id,
          uses: expansion.uses,
          tx,
        });

      return updated;
    });
    writingNeverPublishedDraft = false;
    writingWithoutViolationStatus = false;

    if (!result) throw throwNotFoundError(`No article with id ${id}`);

    // Count-cache refresh hits Redis — run after commit, off the txn budget.
    await userArticleCountCache.refresh(result.userId);

    // remove old cover image
    if (article.coverId !== coverId && article.coverId) {
      const isImgOwner = await isImageOwner({ userId, isModerator, imageId: article.coverId });
      if (isImgOwner) {
        await deleteImageById({ id: article.coverId });
      }
    }

    await applyArticleContentChange({
      id,
      userId,
      content: data.content,
      scanContent: !!scanContent,
      context: {
        ownerId: result.userId,
        title: data.title ?? article.title ?? '',
        previousContent: article.content,
        coverId: coverId ?? article.coverId,
        publication: { status: result.status, scheduledAt: result.scheduledAt },
      },
    });

    // If it was published, process it.
    if (result.publishedAt && result.publishedAt <= new Date()) {
      await eventEngine.processEngagement({
        userId: result.userId,
        type: 'published',
        entityType: 'article',
        entityId: result.id,
      });
    }

    // Tell non-mod owners when a moderator override is currently in force so
    // the client can surface a rescan-warning popover (plan §7b). The
    // override field stays out of the response for mod callers — they have
    // their own controls in the edit UI.
    const hasModeratorOverride =
      !isModerator && article != null && article.moderatorNsfwLevel != null;

    return { ...result, hasModeratorOverride };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (
      writingNeverPublishedDraft &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    )
      throw throwBadRequestError(
        'This article was published while you were editing it. Reload it and save again.'
      );
    if (
      writingWithoutViolationStatus &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    )
      throw throwBadRequestError(ARTICLE_VIOLATION_STATUS_LOCKED_MESSAGE);
    throw throwDbError(error);
  }
};

type ArticleContentChangeContext = {
  ownerId: number;
  title: string | null;
  previousContent: string | null;
  coverId: number | null;
  publication: { status: ArticleStatus; scheduledAt: Date | null };
};

/**
 * The one path for "an article's body changed": the column write plus the follow-up
 * work that change implies. `upsertArticle` calls it, and so does the blurb fan-out —
 * which is what stops the two drifting.
 *
 * Deliberately narrow. The full upsert is form-shaped, so a caller holding only new
 * HTML cannot use it without clearing title, tags, attachments and cover.
 */
export async function applyArticleContentChange({
  id,
  userId,
  content,
  scanContent = true,
  context,
  expectedContent,
}: {
  id: number;
  userId: number;
  content: string;
  scanContent?: boolean;
  /**
   * Compare-and-set: the body this caller READ before splicing. The fan-out does load → splice →
   * save with nothing held across it, so a creator saving in that window had their edit silently
   * reverted by the replay — no error, and the save it clobbered had already returned success.
   * Supplied, a mismatch writes nothing and returns false; the reference stays pending and the
   * next pass re-reads. Omitted, the write is unconditional as before.
   */
  expectedContent?: string;
  /**
   * A caller that has ALREADY written this body passes its pre-write snapshot here. Delete
   * it from such a call site and the re-read below runs after that caller's own commit, so
   * `previousContent` is the new content, `hasContentChanged` is false, and article images
   * silently stop being linked and ingested on every save.
   */
  context?: ArticleContentChangeContext;
}) {
  await throwOnBlockedUserContent(content, { surface: 'article' });

  let resolved = context;
  if (!resolved) {
    const stored = await dbWrite.article.findUnique({
      where: { id },
      select: {
        userId: true,
        title: true,
        content: true,
        coverId: true,
        status: true,
        scheduledAt: true,
      },
    });
    if (!stored) throw throwNotFoundError(`No article with id ${id}`);
    resolved = {
      ownerId: stored.userId,
      title: stored.title,
      previousContent: stored.content,
      coverId: stored.coverId,
      publication: { status: stored.status, scheduledAt: stored.scheduledAt },
    };
  }
  const { ownerId, title, previousContent, coverId, publication } = resolved;

  // A caller holding the pre-write snapshot has already written this body itself. Replaying
  // it would reinstate the older body over a save that committed in between.
  if (!context) {
    // Raw SQL because Prisma's @updatedAt fires on every client-side update(), and a blurb
    // re-materialization is not a user edit: it must not reorder the "Recently Updated"
    // feed or reopen the rating-dispute re-edit window keyed on `updatedAt > resolvedAt`.
    const affected =
      await dbWrite.$executeRaw`UPDATE "Article" SET content = ${content} WHERE id = ${id}${
        expectedContent === undefined ? Prisma.empty : Prisma.sql` AND content = ${expectedContent}`
      }`;
    if (expectedContent !== undefined && !affected) return false;
  }

  await preventReplicationLag('article', id);
  await preventReplicationLag('userArticles', ownerId);

  // Interactive saves only. A fan-out rewrite replaces blurb-span interiors, and
  // BLURB_INTERIOR_ALLOWED_TAGS admits no `img` or `edge-media`, so the body's image set is
  // unchanged by construction — while the `article.update` below would re-stamp the `updatedAt`
  // the raw write above exists to keep off it.
  if (context && content) {
    const hasContentChanged = previousContent !== content;

    if (hasContentChanged) {
      try {
        const { orphanedImageIds } = await linkArticleContentImages({
          articleId: id,
          content,
          userId,
          ownerId,
          coverId,
          cleanupOnly: !scanContent,
        });

        // Delete truly orphaned images (DB + S3 + cache)
        for (const imageId of orphanedImageIds) {
          await deleteImageById({ id: imageId }).catch((error) => {
            handleLogError(error, 'article-orphaned-image-cleanup', {
              articleId: id,
              imageId,
            });
          });
        }

        if (scanContent) {
          // Content changed and images need re-scanning — use Rescan to distinguish a
          // rescan of existing content from an initial pending scan.
          await dbWrite.article.update({
            where: { id },
            data: { scanRequestedAt: new Date(), ingestion: ArticleIngestionStatus.Rescan },
          });
        }
      } catch (e) {
        // Non-blocking: continue even if image linking fails, but log the error
        const error = e as Error;
        logToAxiom({
          type: 'error',
          name: 'article-image-linking',
          message: error.message,
          cause: error.cause,
          stack: error.stack,
          articleId: id,
        }).catch();
      }
    }
  }

  // Submit for text moderation (non-blocking). `submitTextModeration` →
  // `createXGuardModerationRequest` handles contentHash dedup internally,
  // so a save that doesn't change `title` or `content` is a no-op
  // orchestrator-wise. If the article's text was emptied out entirely,
  // drop any stale EntityModeration row — otherwise the retry cron would
  // keep re-submitting and `recomputeArticleIngestion` could still read
  // the old blocked/error state. A draft waits for the save that makes it public: the
  // author may still edit it.
  {
    const currentTitle = title ?? '';
    const hasText = articleHasText(currentTitle, content);

    if (!hasText) {
      await dbWrite.entityModeration.deleteMany({
        where: { entityType: 'Article', entityId: id },
      });
    } else if (isPublicArticle(publication)) {
      const textForModeration = [currentTitle, removeTags(content)].filter(Boolean).join(' ');

      const submitted = submitTextModerationOrScan({
        entityType: 'Article',
        entityId: id,
        xguard: () =>
          submitTextModeration({
            entityType: 'Article',
            entityId: id,
            content: textForModeration,
            labels: ['nsfw'],
            recordForReview: true,
            rearmRetries: true,
          }),
      }).catch((e) => {
        logToAxiom({
          type: 'error',
          name: 'article-text-moderation',
          message: (e as Error).message,
          articleId: id,
        }).catch();
      });
      // Otherwise the recompute below can count a verdict for older text and take it live.
      if (articleAwaitsTextVerdict(publication)) await submitted;
    }
  }

  // Lock ingestion state, recompute nsfwLevel from current cover/content
  // signals, and queue the search-index update. Running the full
  // `updateArticleImageScanStatus` (rather than bare `recomputeArticleIngestion`)
  // guarantees that any edit or publish/republish re-derives
  // `Article.nsfwLevel` from ground truth — otherwise a cover whose scan
  // finished between save and republish would leak at its stale
  // author-declared level. Dispatches the search-index update internally.
  await updateArticleImageScanStatus([id]).catch((e) =>
    handleLogError(e, 'article-update-recompute', { articleId: id })
  );

  return true;
}

/**
 * An image an article's cleanup may delete: the author's own, in no post, and shown nowhere else.
 * Most of these relations null out on delete, so a missed one silently blanks that surface:
 * a new relation that displays an image belongs here. An image that is reported, awaiting review
 * or blocked is kept too: moderation decides what happens to it, not an article edit.
 */
export const unusedAuthorImage = (ownerId: number) =>
  ({
    userId: ownerId,
    postId: null,
    needsReview: null,
    ingestion: { not: ImageIngestionStatus.Blocked },
    nsfwLevel: { not: NsfwLevel.Blocked },
    blockedFor: null,
    reports: { none: {} },
    article: { is: null },
    assignedUser: { is: null },
    connections: { none: {} },
    collectionItems: { none: {} },
    collections: { none: {} },
    UserProfile: { none: {} },
    userProfileSfwCover: { none: {} },
    announcementCovers: { none: {} },
    clubCover: { none: {} },
    clubHeader: { none: {} },
    clubAvatar: { none: {} },
    clubTierCover: { none: {} },
    clubPostCoverImage: { none: {} },
    purchasableRewards: { none: {} },
    CosmeticShopSection: { none: {} },
    comicPanels: { none: {} },
    comicReferenceImages: { none: {} },
    comicProjectCover: { none: {} },
    comicProjectHero: { none: {} },
    challengesCover: { none: {} },
    challengeWins: { none: {} },
    challengeEventCovers: { none: {} },
    model3dThumbnails: { none: {} },
    model3dSources: { none: {} },
    appListingIcons: { none: {} },
    appListingCovers: { none: {} },
    appListingScreenshots: { none: {} },
    appSubListingImages: { none: {} },
    appSubListingPendingImages: { none: {} },
    crucibles: { none: {} },
    crucibleHeroes: { none: {} },
    crucibleEntries: { none: {} },
    storylineCovers: { none: {} },
    storylineHeroes: { none: {} },
    storylineCoverUploads: { none: {} },
  } satisfies Prisma.ImageWhereInput);

/**
 * Deleting an orphaned image deletes its object, so one whose key shop artwork uses stays: an
 * article saved before shop keys were refused can hold one.
 */
async function withoutShopArtwork(
  db: Prisma.TransactionClient | typeof dbWrite,
  images: { id: number; url: string }[]
) {
  if (!images.length) return [];
  const shopUrls = await shopArtworkUrls(
    images.map((image) => image.url),
    db
  );
  return images.filter((image) => !shopUrls.has(image.url)).map((image) => image.id);
}

/**
 * Drops images used as a service offering's cover. That column has no Prisma relation, so
 * `unusedAuthorImage` cannot see it; a new plain image-id column needs the same treatment.
 */
async function withoutOfferingCovers(
  db: Pick<Prisma.TransactionClient, 'serviceOffering'>,
  imageIds: number[]
) {
  if (!imageIds.length) return imageIds;
  const covers = await db.serviceOffering.findMany({
    where: { coverImageId: { in: imageIds } },
    select: { coverImageId: true },
  });
  const used = new Set(covers.map((offering) => offering.coverImageId));
  return imageIds.filter((id) => !used.has(id));
}

/**
 * An owner with a safety report on file, or under any legal hold, keeps every image: the review
 * needs them. Held when the hold cannot be read. Read outside any transaction: a failed read would
 * abort it.
 */
export async function ownerUnderSafetyReport(
  db: Pick<Prisma.TransactionClient, 'csamReport' | '$queryRaw'>,
  ownerId: number
) {
  try {
    if ((await db.csamReport.count({ where: { userId: ownerId } })) > 0) return true;
    const owner = Prisma.sql`${ownerId}::int`;
    const [row] =
      (await db.$queryRaw<{ held: unknown }[]>`
        SELECT (${owner} = ${PLACEHOLDER_OWNER_ID} OR ${accountHoldSql(owner, true)}) AS held
      `) ?? [];
    return row?.held !== false;
  } catch (error) {
    handleLogError(error as Error, 'article-image-cleanup-hold-read', { ownerId });
    return true;
  }
}

export const deleteArticleById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator?: boolean }) => {
  try {
    const article = await dbWrite.article.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!article) throw throwNotFoundError(`No article with id ${id}`);

    const isOwner = article.userId === userId || isModerator;
    if (!isOwner) throw throwAuthorizationError(`You cannot perform this action`);

    // Collect content image IDs BEFORE the transaction deletes connections
    const contentImageConnections = await dbWrite.imageConnection.findMany({
      where: { entityId: id, entityType: ImageConnectionType.Article },
      select: { imageId: true },
    });

    // Before the transaction: `CollectionItem.articleId` cascades from `Article`.
    const collectionsToRebuild = await getCollectionIdsForArticle({ articleId: id });

    const markerView = await holdMarkerViewExists();
    const deleted = await dbWrite.$transaction(async (tx) => {
      await tx.$executeRaw(
        detachHeldThreadsSql({ articleId: Prisma.sql`SELECT ${id}::int` }, markerView)
      );
      const article = await tx.article.delete({
        where: { id },
        select: { coverId: true },
      });

      await tx.file.deleteMany({ where: { entityId: id, entityType: 'Article' } });
      await tx.imageConnection.deleteMany({
        where: { entityId: id, entityType: ImageConnectionType.Article },
      });

      return article;
    });

    // Immediately after the commit: the steps below can reject, and the article row is
    // already gone, so the pre-delete snapshot is the only record left.
    await enqueueCollectionRebuild({ ...collectionsToRebuild, source: 'article-delete' });

    // The cover goes through the same checks as the content images: it can be someone else's
    // upload, or still shown elsewhere.
    const imageIds = [
      ...new Set([
        ...(deleted.coverId ? [deleted.coverId] : []),
        ...contentImageConnections.map((conn) => conn.imageId),
      ]),
    ];

    // The article is already gone, so a failed cleanup is logged rather than reported as a failed
    // delete, and it must not skip the articles-index `Delete` below.
    try {
      if (imageIds.length > 0 && !(await ownerUnderSafetyReport(dbWrite, article.userId))) {
        const trulyOrphanedImages = await dbWrite.image.findMany({
          where: { id: { in: imageIds }, ...unusedAuthorImage(article.userId) },
          select: { id: true, url: true },
        });

        const deletable = await withoutOfferingCovers(
          dbWrite,
          await withoutShopArtwork(dbWrite, trulyOrphanedImages)
        );
        // Per image, so one failed delete does not stop the rest.
        for (const imageId of deletable) {
          await deleteImageById({ id: imageId }).catch((error) => {
            handleLogError(
              error,
              imageId === deleted.coverId
                ? 'article-cover-image-cleanup'
                : 'article-content-image-cleanup',
              { articleId: id, imageId }
            );
          });
        }
      }
    } catch (error) {
      handleLogError(error as Error, 'article-image-cleanup', { articleId: id });
    }

    await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getDraftArticlesByUserId = async ({
  userId,
  page,
  limit,
}: GetAllSchema & { userId: number }) => {
  try {
    const { take, skip } = getPagination(limit, page);
    const where: Prisma.ArticleFindManyArgs['where'] = {
      userId,
      status: { in: [ArticleStatus.Draft, ArticleStatus.Unpublished] },
    };

    const db = await getDbWithoutLag('userArticles', userId);
    const articles = await db.article.findMany({
      take,
      skip,
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        status: true,
        scheduledAt: true,
        tags: {
          where: { tag: { isCategory: true } },
          select: { tag: { select: { id: true, name: true } } },
        },
      },
    });
    const count = await db.article.count({ where });

    const items = articles.map(({ tags, ...article }) => ({
      ...article,
      category: tags[0]?.tag,
    }));

    return getPagingData({ items, count }, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function unpublishArticleById({
  id,
  reason,
  customMessage,
  metadata,
  userId,
  isModerator,
}: {
  id: number;
  reason?: string;
  customMessage?: string;
  metadata?: ArticleMetadata;
  userId: number;
  isModerator?: boolean;
}) {
  // Fetch article
  const db = await getDbWithoutLag('article', id);
  const article = await db.article.findUnique({
    where: { id },
    select: { userId: true, publishedAt: true, status: true },
  });

  if (!article) throw throwNotFoundError(`No article with id ${id}`);

  // Permission check (defensive, already checked in middleware)
  const isOwner = article.userId === userId || isModerator;
  if (!isOwner) throw throwAuthorizationError('You cannot perform this action');

  // State validation
  if (!article.publishedAt || article.status !== ArticleStatus.Published) {
    throw throwBadRequestError('Article is not published');
  }

  // Atomic update with transaction
  const updated = await dbWrite.$transaction(
    async (tx) => {
      const unpublishedAt = new Date().toISOString();

      // Build updated metadata
      const updatedMetadata = {
        ...metadata,
        ...(reason
          ? {
              unpublishedReason: reason,
              customMessage,
            }
          : {}),
        unpublishedAt,
        unpublishedBy: userId,
      };

      // Update article status and metadata
      return await tx.article.update({
        where: { id },
        data: {
          status: reason ? ArticleStatus.UnpublishedViolation : ArticleStatus.Unpublished,
          metadata: updatedMetadata,
        },
      });
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Update search index (remove from public search)
  await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

  // Bust user content cache
  await userArticleCountCache.refresh(article.userId);
  await preventReplicationLag('article', id);
  await preventReplicationLag('userArticles', article.userId);

  return updated;
}

// NOTE(moderator-migration): restoreArticleById removed — article restore is now a moderator-app action
// (apps/moderator, Kysely; see article-moderation.ts). See docs/moderator-app/context-menu-mod-actions.md.

// --- Article Image Scanning Functions ---

/** The content image urls of `content` with no `Image` row. */
async function contentUrlsWithoutRows(content: string) {
  const urls = [...new Set(getContentMedia(content).map((media) => media.url))];
  if (!urls.length) return [];
  const existing = await dbWrite.image.findMany({
    where: { url: { in: urls } },
    select: { url: true },
  });
  const existingUrls = new Set(existing.map((image) => image.url));
  return urls.filter((url) => !existingUrls.has(url));
}

/**
 * The content urls `linkArticleContentImages` would create rows for, checked against the article's
 * owner. A url this save adds must pass the client image url checks; one already in the stored
 * content is refused only when its row or upload key belongs to another user.
 */
export async function assertArticleContentUrlsUsable({
  content,
  storedContent,
  userId,
  ownerId,
}: {
  content: string;
  storedContent?: string | null;
  userId: number;
  ownerId: number;
}) {
  const missing = await contentUrlsWithoutRows(content);
  const stored = new Set(storedContent ? getContentMedia(storedContent).map((m) => m.url) : []);
  try {
    for (const urls of urlChunks(missing.filter((url) => !stored.has(url)))) {
      await assertClientImageUrlsUsable({ urls, userId: ownerId });
      await assertClientKeysIssuedToCaller({ urls, userId: ownerId, alsoIssuedTo: userId });
    }
    for (const urls of urlChunks(missing.filter((url) => stored.has(url)))) {
      await assertClientImageUrlsUsable({ urls, userId: ownerId, shopArtwork: false });
      const { issuedToOthers } = await keyIssuers({ urls, userId: ownerId, alsoIssuedTo: userId });
      if (issuedToOthers.length) throw imageUrlUnavailableError();
    }
  } catch (error) {
    if (error instanceof TRPCError && error.message === COVER_IMAGE_UNAVAILABLE_MESSAGE)
      throw imageUrlUnavailableError(ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE);
    throw error;
  }
}

/** Each check takes a bounded number of keys; an article can hold more images than that. */
const CONTENT_URLS_PER_CHECK = 16;
function urlChunks(urls: string[]) {
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += CONTENT_URLS_PER_CHECK) {
    chunks.push(urls.slice(i, i + CONTENT_URLS_PER_CHECK));
  }
  return chunks;
}

/**
 * For content already saved: `assertClientImageUrlsUsable` on the urls with no row, and the keys
 * among them that were issued to another user or have no issue record, reported, not refused.
 */
export async function checkSavedArticleContentUrls({
  content,
  ownerId,
}: {
  content: string;
  ownerId: number;
}) {
  const result = {
    issuedToOthers: [] as string[],
    unrecorded: [] as string[],
    lookupFailed: false,
  };
  for (const urls of urlChunks(await contentUrlsWithoutRows(content))) {
    await assertClientImageUrlsUsable({ urls, userId: ownerId, shopArtwork: false });
    const issuers = await keyIssuers({ urls, userId: ownerId });
    result.issuedToOthers.push(...issuers.issuedToOthers);
    result.unrecorded.push(...issuers.unrecorded);
    result.lookupFailed ||= issuers.recordReadFailed || issuers.requestLogReadFailed;
  }
  return result;
}

/** The content urls with no `Image` row whose upload key was issued to someone else. */
async function contentUrlsIssuedToOthers({
  content,
  userId,
  ownerId,
}: {
  content: string;
  userId: number;
  ownerId: number;
}) {
  const refused = new Set<string>();
  for (const urls of urlChunks(await contentUrlsWithoutRows(content))) {
    const { issuedToOthers } = await keyIssuers({ urls, userId: ownerId, alsoIssuedTo: userId });
    const others = new Set(issuedToOthers);
    for (const url of urls) if (keysIn(url).some((key) => others.has(key))) refused.add(url);
  }
  return refused;
}

/**
 * Content images become `Image` rows, and deleting one removes its object, so an article may not
 * embed a key that shop artwork uses. Checked before the write: linking runs after it, and must
 * create and scan a row for every image the content holds. Only images new to this save count, so
 * an article that already holds one can still be edited.
 */
async function assertNoShopArtworkInContent(
  content: string | null | undefined,
  storedContent: string | null | undefined
) {
  if (!content) return;
  const stored = new Set(storedContent ? getContentMedia(storedContent).map((m) => m.url) : []);
  const added = getContentMedia(content)
    .map((media) => media.url)
    .filter((url) => !stored.has(url));
  if (!added.length) return;
  const shopUrls = await shopArtworkUrls(added);
  if (shopUrls.size) throw imageUrlUnavailableError(ARTICLE_CONTENT_IMAGE_UNAVAILABLE_MESSAGE);
}

/**
 * Link article content images to article entity
 * Creates Image entities and ImageConnections for all embedded images
 *
 * Uses batch queries to prevent N+1 performance issues
 *
 * @param articleId - Article ID to link images to
 * @param content - Article HTML content
 * @param userId - User ID for image ownership
 * @param ownerId - The article's author: only their own images, used nowhere else, are returned
 *   as orphans to delete.
 */
export async function linkArticleContentImages({
  articleId,
  content,
  userId,
  ownerId,
  coverId,
  cleanupOnly,
}: {
  articleId: number;
  content: string;
  userId: number;
  ownerId: number;
  coverId?: number | null;
  cleanupOnly?: boolean;
}): Promise<{ orphanedImageIds: number[] }> {
  const contentImages = getContentMedia(content);
  const issuedToOthers = cleanupOnly
    ? new Set<string>()
    : await contentUrlsIssuedToOthers({ content, userId, ownerId });

  const { orphanedImageIds, imagesToIngest } = await dbWrite.$transaction(async (tx) => {
    const imageUrls = contentImages.map((img) => img.url);

    // Track content image IDs for orphan detection
    let contentImageIds: number[] = [];
    let imagesToIngest: { id: number; url: string; ingestion?: ImageIngestionStatus }[] = [];

    if (!cleanupOnly) {
      // Batch query: Get all existing images in one query
      const existingImages = await tx.image.findMany({
        where: { url: { in: imageUrls } },
        select: { id: true, url: true, ingestion: true },
      });

      const existingUrlMap = new Map(existingImages.map((img) => [img.url, img]));

      // Batch create: Missing images (upsert with unique constraint handles races)
      // A key issued to another user gets no row here, so a deleted row of theirs is not re-created.
      const missingMedia = contentImages.filter(
        (media) => !existingUrlMap.has(media.url) && !issuedToOthers.has(media.url)
      );
      const newlyCreatedImages: { id: number; url: string }[] = [];

      if (missingMedia.length > 0) {
        const newImages = await tx.image.createManyAndReturn({
          data: missingMedia.map((media) => ({
            url: media.url,
            userId,
            type: media.type,
            name: media.alt,
            ingestion: ImageIngestionStatus.Pending,
            scanRequestedAt: new Date(),
          })),
          select: { id: true, url: true },
          skipDuplicates: true,
        });

        newImages.forEach((img) => {
          existingUrlMap.set(img.url, { ...img, ingestion: ImageIngestionStatus.Pending });
          newlyCreatedImages.push(img);
        });
      }

      // Batch upsert: ImageConnections
      for (const url of imageUrls) {
        const image = existingUrlMap.get(url);
        if (!image) continue;

        await tx.imageConnection.upsert({
          where: {
            imageId_entityType_entityId: {
              imageId: image.id,
              entityType: ImageConnectionType.Article,
              entityId: articleId,
            },
          },
          create: {
            imageId: image.id,
            entityType: ImageConnectionType.Article,
            entityId: articleId,
          },
          update: {},
        });
      }

      contentImageIds = Array.from(existingUrlMap.values()).map((img) => img.id);

      // Queue images for ingestion
      const pendingExistingImages = existingImages.filter(
        (img) => img.ingestion === ImageIngestionStatus.Pending
      );
      imagesToIngest = [...newlyCreatedImages, ...pendingExistingImages];
    } else {
      // In cleanupOnly mode, we still need to know which images are in the current content
      // so we can detect orphans. Query by URL to get their IDs.
      const existingImages = await tx.image.findMany({
        where: { url: { in: imageUrls } },
        select: { id: true },
      });
      contentImageIds = existingImages.map((img) => img.id);
    }

    // --- Orphan detection (always runs) ---

    // Build exclusion list: content images + cover image
    const excludeImageIds = [...contentImageIds];
    if (coverId) excludeImageIds.push(coverId);

    // Get orphaned connections for this article
    const orphanedConnections = await tx.imageConnection.findMany({
      where: {
        entityType: ImageConnectionType.Article,
        entityId: articleId,
        imageId: { notIn: excludeImageIds },
      },
      select: { imageId: true },
    });

    const orphanedIds = orphanedConnections.map((conn) => conn.imageId);

    // Delete the orphaned connections
    if (orphanedIds.length > 0) {
      await tx.imageConnection.deleteMany({
        where: {
          entityType: ImageConnectionType.Article,
          entityId: articleId,
          imageId: { in: orphanedIds },
        },
      });
    }

    let trulyOrphanedIds: number[] = [];
    if (orphanedIds.length > 0) {
      const trulyOrphaned = await tx.image.findMany({
        where: { id: { in: orphanedIds }, ...unusedAuthorImage(ownerId) },
        select: { id: true, url: true },
      });
      trulyOrphanedIds = await withoutOfferingCovers(
        tx,
        await withoutShopArtwork(tx, trulyOrphaned)
      );
    }

    return { orphanedImageIds: trulyOrphanedIds, imagesToIngest };
  });

  // After the commit: the hold read must not be able to roll back the edit's image linking.
  const deletable =
    orphanedImageIds.length > 0 && !(await ownerUnderSafetyReport(dbWrite, ownerId))
      ? orphanedImageIds
      : [];

  if (imagesToIngest.length > 0) {
    // TODO.articleImageScan: remove the lowPriority flag
    enqueueImageIngestion({
      images: imagesToIngest,
      name: 'article-image-ingest',
      userId,
      lowPriority: true,
    });
  }

  return { orphanedImageIds: deletable };
}

/**
 * Get article image scan status for real-time progress tracking
 *
 * @param articleId - Article ID to get scan status for
 * @returns Object with scan progress counts, completion status, and detailed image lists
 */
export type ArticleTextModerationStatus = {
  // True when the article is public and has text to moderate (title or HTML-stripped content).
  // When false, the text pipeline is a no-op and textDone is implicitly true.
  required: boolean;
  // null when no EntityModeration row exists yet (either not required or
  // the submit call is still in flight and hasn't written a Pending row).
  status: EntityModerationStatus | null;
  blocked: boolean | null;
  retryCount: number;
  updatedAt: Date | null;
};

// `scanJobs.error` is stamped by `markImageScanError` (image-scan-pipeline, scan
// verdicts) and `markImageScanSubmitFailure` (image.service, submit rejections). Both
// carry the classifier's verdict (transient | permanent | unknown) plus the human reason,
// letting the scan-status UI render a class-aware cause.
function extractScanFailure(scanJobs: Prisma.JsonValue): {
  failureClass: string | null;
  reason: string | null;
} {
  const error =
    scanJobs && typeof scanJobs === 'object' && !Array.isArray(scanJobs)
      ? (scanJobs as Record<string, unknown>).error
      : null;
  if (!error || typeof error !== 'object') return { failureClass: null, reason: null };
  const { failureClass, reason } = error as { failureClass?: unknown; reason?: unknown };
  return {
    failureClass: typeof failureClass === 'string' ? failureClass : null,
    reason: typeof reason === 'string' ? reason : null,
  };
}

export async function getArticleScanStatus({ id }: GetByIdInput): Promise<{
  total: number;
  scanned: number;
  blocked: number;
  error: number;
  pending: number;
  allComplete: boolean;
  images: {
    blocked: Array<{
      id: number;
      url: string;
      ingestion: ImageIngestionStatus;
      blockedFor: string | null;
      nsfwLevelLocked: boolean;
    }>;
    error: Array<{
      id: number;
      url: string;
      ingestion: ImageIngestionStatus;
      nsfwLevelLocked: boolean;
      failureClass: string | null;
      reason: string | null;
    }>;
    pending: Array<{ id: number; url: string; ingestion: ImageIngestionStatus }>;
  };
  textModeration: ArticleTextModerationStatus;
}> {
  const [connections, article, moderation] = await Promise.all([
    dbRead.imageConnection.findMany({
      where: {
        entityId: id,
        entityType: ImageConnectionType.Article,
      },
      include: {
        image: {
          select: {
            id: true,
            url: true,
            ingestion: true,
            blockedFor: true,
            nsfwLevelLocked: true,
            scanJobs: true,
          },
        },
      },
    }),
    dbRead.article.findUnique({
      where: { id },
      select: { title: true, content: true, coverId: true, status: true, scheduledAt: true },
    }),
    dbRead.entityModeration.findUnique({
      where: { entityType_entityId: { entityType: 'Article', entityId: id } },
      select: { status: true, blocked: true, retryCount: true, updatedAt: true },
    }),
  ]);

  // Cover lives on `Article.coverId`, not in `ImageConnection`, so a cover-only
  // problem (no content images) would otherwise render nothing. Fold it into the
  // scannable set, deduped against any connection that also references it.
  const cover = article?.coverId
    ? await dbRead.image.findUnique({
        where: { id: article.coverId },
        select: {
          id: true,
          url: true,
          ingestion: true,
          blockedFor: true,
          nsfwLevelLocked: true,
          scanJobs: true,
        },
      })
    : null;

  const images = connections.map((c) => c.image);
  if (cover && !images.some((image) => image.id === cover.id)) images.push(cover);

  const total = images.length;
  const scannedImages = images.filter((i) => i.ingestion === ImageIngestionStatus.Scanned);
  const blockedImages = images.filter((i) => i.ingestion === ImageIngestionStatus.Blocked);
  const errorImages = images.filter(
    (i) =>
      i.ingestion === ImageIngestionStatus.Error || i.ingestion === ImageIngestionStatus.NotFound
  );
  // Rescan is a re-queued (in-flight) image — treat it as non-terminal alongside
  // Pending so `allComplete` is false and the client keeps polling until it settles.
  const pendingImages = images.filter(
    (i) =>
      i.ingestion === ImageIngestionStatus.Pending || i.ingestion === ImageIngestionStatus.Rescan
  );

  // A draft's text is not scanned until the save that makes it public, so no verdict is coming.
  // A blocked verdict still counts: it is what moved the article to UnpublishedViolation.
  const textBlocked =
    moderation?.status === EntityModerationStatus.Succeeded && !!moderation.blocked;
  const required =
    !!article &&
    (isPublicArticle(article) || textBlocked) &&
    articleHasText(article.title, article.content);
  const textTerminalStatuses = new Set<EntityModerationStatus>([
    EntityModerationStatus.Succeeded,
    EntityModerationStatus.Failed,
    EntityModerationStatus.Expired,
    EntityModerationStatus.Canceled,
  ]);
  const textDone = !required || (!!moderation && textTerminalStatuses.has(moderation.status));

  return {
    total,
    scanned: scannedImages.length,
    blocked: blockedImages.length,
    error: errorImages.length,
    pending: pendingImages.length,
    allComplete: pendingImages.length === 0 && textDone,
    images: {
      blocked: blockedImages.map((i) => ({
        id: i.id,
        url: i.url,
        ingestion: i.ingestion,
        blockedFor: i.blockedFor,
        nsfwLevelLocked: i.nsfwLevelLocked,
      })),
      error: errorImages.map((i) => {
        const { failureClass, reason } = extractScanFailure(i.scanJobs);
        return {
          id: i.id,
          url: i.url,
          ingestion: i.ingestion,
          nsfwLevelLocked: i.nsfwLevelLocked,
          failureClass,
          reason,
        };
      }),
      pending: pendingImages.map((i) => ({
        id: i.id,
        url: i.url,
        ingestion: i.ingestion,
      })),
    },
    textModeration: {
      required,
      status: moderation?.status ?? null,
      blocked: moderation?.blocked ?? null,
      retryCount: moderation?.retryCount ?? 0,
      updatedAt: moderation?.updatedAt ?? null,
    },
  };
}

/**
 * Update article scan status after images complete scanning.
 *
 * Recomputes the article's nsfwLevel once all images reach a terminal state,
 * then delegates all status/ingestion transitions (Processing→Published,
 * Pending/Rescan→Scanned/Blocked/Error) and author notifications to
 * `recomputeArticleIngestion`, which is the single source of truth for
 * article scan state.
 */
export async function updateArticleImageScanStatus(articleIds: number[]): Promise<void> {
  for (const articleId of articleIds) {
    // One atomic transaction: advisory lock → NSFW level update → ingestion
    // recompute. Closes the drift window where a crash between the NSFW
    // update and the recompute would leave the Article row with updated
    // nsfwLevel but stale ingestion.
    //
    // NSFW recompute runs unconditionally: the SQL in `updateArticleNsfwLevels`
    // already filters to Scanned/Blocked cover + Scanned content, so it is
    // safe on partial state. Gating this on "all content images terminal"
    // historically let R/X/XXX covers leak into the SFW feed whenever any
    // content image was still Pending — the cover had already resolved but
    // the article's nsfwLevel stayed pinned to userNsfwLevel until the last
    // content image finished.
    const result = await dbWrite.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

        await updateArticleNsfwLevels([articleId], tx);

        return recomputeArticleIngestionInTx(tx, articleId);
      },
      { timeout: 30000, maxWait: 10000 }
    );

    await dispatchArticleIngestionPostCommit(result);
  }
}

/**
 * Does this article have any text worth sending to the text-moderation pipeline?
 * Shared between the submit-text-moderation gate and the recomputeArticleIngestion
 * empty-content branch so the two can't drift: anything that wouldn't be submitted
 * must also be treated as "textDone" by the state machine, otherwise the article
 * gets trapped in Pending waiting for a moderation callback that will never come.
 */
export function articleHasText(title: string | null, content: string | null): boolean {
  const titleText = title?.trim() ?? '';
  const contentText = removeTags(content ?? '').trim();
  return titleText.length > 0 || contentText.length > 0;
}

/**
 * Recompute Article.ingestion from ground truth (Image.ingestion + EntityModeration)
 * and drive associated status transitions.
 *
 * Single source of truth for article scan state. Call it after:
 * - Image scan webhooks (via updateArticleImageScanStatus)
 * - Text moderation webhooks (success or failure)
 * - Article upsert (to lock in Pending state)
 * - Backfill / reconcile per article
 *
 * Transitions handled:
 * - ingestion -> Scanned: sets contentScannedAt; if status == Processing, flips
 *   status to Published and sends the "article published" notification.
 * - ingestion -> Blocked/Error (all images terminal) while status == Processing:
 *   sends the "images blocked/failed" notification so the author can fix and
 *   resubmit. Status is left at Processing so the author can edit.
 */
export type RecomputeIngestionResult = {
  articleId: number;
  publishedNotificationUserId: number | null;
  problemsNotification: { userId: number; blockedImages: number; errorImages: number } | null;
};

/**
 * In-transaction half of the ingestion state machine. Takes the advisory lock,
 * reads ground truth (image connections + EntityModeration + article fields),
 * derives the next ingestion state, and writes the Article row. Returns hints
 * for post-commit dispatch (search index queue + notifications) — those MUST be
 * run after commit via `dispatchArticleIngestionPostCommit`, otherwise Redis
 * queue / notification failures would roll back the state write.
 *
 * Exposed as a primitive so callers that need to combine ingestion recompute
 * with other writes (text-moderation webhook, updateArticleImageScanStatus) can
 * run everything under a single advisory-locked transaction. The advisory lock
 * is re-entrant within the same session, so taking it again here if the caller
 * already did is safe.
 */
export async function recomputeArticleIngestionInTx(
  tx: Prisma.TransactionClient,
  articleId: number
): Promise<RecomputeIngestionResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

  // --- Image side (content images + cover) ---
  //
  // Cover lives on `Article.coverId` and is *not* duplicated into
  // `ImageConnection`, so we have to read it separately and fold it into the
  // terminal-state counts. Without this, an article with zero content images
  // and a still-Pending cover would compute `imageDone=true` and flip to
  // `ingestion=Scanned`, publishing the article while its cover rating is
  // still unknown. A cover whose scan later resolves to R/X/XXX (or Blocked)
  // would then need the webhook-driven forward path to propagate — and any
  // missed or disabled webhook becomes a silent leak.
  //
  // Counting the cover here means:
  //   - cover still Pending → imageDone=false → ingestion=Pending → search
  //     index drops the article until the cover resolves.
  //   - cover Scanned/Blocked → contributes to imageDone; Blocked also
  //     escalates to `imageBlocked` so the article transitions to
  //     ingestion=Blocked (hidden from feed) instead of silently leaking.
  //   - cover changed on edit (new Pending image) → ingestion falls back to
  //     Pending automatically on the next recompute, no special-case save
  //     logic required.
  const connections = await tx.imageConnection.findMany({
    where: { entityId: articleId, entityType: ImageConnectionType.Article },
    include: { image: { select: { ingestion: true } } },
  });

  const current = await tx.article.findUniqueOrThrow({
    where: { id: articleId },
    select: {
      ingestion: true,
      status: true,
      publishedAt: true,
      userId: true,
      title: true,
      content: true,
      coverId: true,
      moderatorNsfwLevel: true,
    },
  });

  const coverIngestion = current.coverId
    ? (
        await tx.image.findUnique({
          where: { id: current.coverId },
          select: { ingestion: true },
        })
      )?.ingestion ?? null
    : null;

  const imageStates: ImageIngestionStatus[] = [
    ...connections.map((c) => c.image.ingestion),
    ...(coverIngestion ? [coverIngestion] : []),
  ];

  const totalImages = imageStates.length;
  const scannedImages = imageStates.filter((s) => s === ImageIngestionStatus.Scanned).length;
  const blockedImages = imageStates.filter((s) => s === ImageIngestionStatus.Blocked).length;
  const errorImages = imageStates.filter(
    (s) => s === ImageIngestionStatus.Error || s === ImageIngestionStatus.NotFound
  ).length;

  const imageBlocked = blockedImages > 0;
  const imageError = errorImages > 0;
  const imageDone =
    totalImages === 0 || scannedImages + blockedImages + errorImages === totalImages;

  // --- Text moderation side ---
  const textModeration = await tx.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: 'Article', entityId: articleId } },
    select: { status: true, blocked: true },
  });

  // Articles with no text to scan (empty/null title AND content) can never
  // receive a moderation callback, so we must treat them as textDone here.
  // Also guards blocked/error on any stale EntityModeration row whose
  // content has since been emptied.
  const hasText = articleHasText(current.title, current.content);
  const textErrorStatuses: string[] = [
    EntityModerationStatus.Failed,
    EntityModerationStatus.Expired,
    EntityModerationStatus.Canceled,
  ];
  const textBlocked =
    hasText &&
    textModeration?.status === EntityModerationStatus.Succeeded &&
    textModeration.blocked === true;
  const textError =
    hasText && !!textModeration && textErrorStatuses.includes(textModeration.status);
  const textDone = !hasText || textModeration?.status === EntityModerationStatus.Succeeded;

  // --- Derive ingestion state (precedence documented on deriveArticleIngestionState) ---
  const hasModeratorOverride = current.moderatorNsfwLevel != null;

  const next = deriveArticleIngestionState({
    imageBlocked,
    imageError,
    imageDone,
    textBlocked,
    textError,
    textDone,
    hasModeratorOverride,
  });

  const flipToPublished =
    next === ArticleIngestionStatus.Scanned && current.status === ArticleStatus.Processing;

  const setScannedAt =
    next === ArticleIngestionStatus.Scanned && current.ingestion !== ArticleIngestionStatus.Scanned;
  const flipPublishedAt = flipToPublished ? current.publishedAt ?? new Date() : null;

  // Raw SQL because Prisma's @updatedAt on Article.updatedAt fires on every
  // client-side update(), which would bump "Recently Updated" feed position
  // every time a scan webhook or the reconcile cron touches the row. Writing
  // only the scan-state columns via $executeRaw bypasses that.
  const setFragments: Prisma.Sql[] = [Prisma.sql`ingestion = ${next}::"ArticleIngestionStatus"`];
  if (setScannedAt) {
    setFragments.push(Prisma.sql`"contentScannedAt" = ${new Date()}`);
  }
  if (flipToPublished) {
    setFragments.push(Prisma.sql`status = ${ArticleStatus.Published}::"ArticleStatus"`);
    setFragments.push(Prisma.sql`"publishedAt" = ${flipPublishedAt}`);
  }
  await tx.$executeRaw`
    UPDATE "Article"
    SET ${Prisma.join(setFragments, ', ')}
    WHERE id = ${articleId}
  `;

  // Populate post-commit hints. Notifications dedupe via `key`
  // (article-published-$id / article-images-blocked-$id) so re-notifying on
  // repeated terminal-state recomputes is safe.
  let publishedNotificationUserId: number | null = null;
  let problemsNotification: { userId: number; blockedImages: number; errorImages: number } | null =
    null;

  if (flipToPublished) {
    publishedNotificationUserId = current.userId;
  } else if (
    current.status === ArticleStatus.Processing &&
    imageDone &&
    (next === ArticleIngestionStatus.Blocked || next === ArticleIngestionStatus.Error) &&
    (blockedImages > 0 || errorImages > 0)
  ) {
    // Fire once all images are terminal and at least one is problematic.
    // No ingestion-transition guard: if an early image blocks, ingestion
    // moves to Blocked before the remaining Pending images finish; by the
    // time they do, ingestion is unchanged and a transition check would
    // miss the notification.
    problemsNotification = {
      userId: current.userId,
      blockedImages,
      errorImages,
    };
  }

  return { articleId, publishedNotificationUserId, problemsNotification };
}

/**
 * Post-commit side effects for `recomputeArticleIngestionInTx`. Must run after
 * the transaction commits so that:
 *   - the search-index indexer reads committed state when it dequeues the id,
 *   - notification failures don't roll back the ingestion state write.
 *
 * Search index queue and notifications dedupe on their own, so calling this
 * twice for the same result is safe.
 */
export async function dispatchArticleIngestionPostCommit(
  result: RecomputeIngestionResult
): Promise<void> {
  const { articleId, publishedNotificationUserId, problemsNotification } = result;

  // Sync search index — the index filters on ingestion = 'Scanned', so any
  // ingestion state change must be reflected (add when Scanned, remove otherwise).
  await articlesSearchIndex.queueUpdate([
    { id: articleId, action: SearchIndexUpdateQueueAction.Update },
  ]);

  if (publishedNotificationUserId !== null) {
    await createNotification({
      userId: publishedNotificationUserId,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `article-published-${articleId}`,
      details: {
        message: `Your article has been published successfully!`,
        url: `/articles/${articleId}`,
      },
    }).catch((e) => handleLogError(e, 'article-ingestion-published-notification', { articleId }));
  }

  if (problemsNotification) {
    const { userId, blockedImages, errorImages } = problemsNotification;
    await createNotification({
      userId,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `article-images-blocked-${articleId}`,
      details: {
        message: `Your article cannot be published: ${
          blockedImages > 0
            ? `${blockedImages} image(s) blocked (policy violation)`
            : `${errorImages} image(s) failed to scan`
        }. Please remove or replace these images and resubmit.`,
        url: `/articles/${articleId}/edit`,
      },
    }).catch((e) => handleLogError(e, 'article-ingestion-problems-notification', { articleId }));
  }

  // Owner re-disputed during a Rescan (gate blocked on `ingestion != Scanned`)
  // and the scan has now settled — re-evaluate the auto-approve gate. The
  // helper is fully self-contained and never throws.
  await maybeAutoResolveDisputeAfterScan(articleId);
}

export async function recomputeArticleIngestion(articleId: number): Promise<void> {
  const result = await dbWrite.$transaction(
    async (tx) => recomputeArticleIngestionInTx(tx, articleId),
    {
      timeout: 30000,
      maxWait: 10000,
    }
  );
  await dispatchArticleIngestionPostCommit(result);
}

/**
 * Moderator override for a single article image stuck at Error/Blocked. Reuses
 * `resolveIngestionError` to set the level + lock + `ingestion=Scanned`, then
 * recomputes the article so it leaves Error/Blocked and re-queues the search
 * index. Works for Blocked images too — un-blocking a policy-blocked image is an
 * intentional moderator decision, and the resulting lock keeps a later article
 * rescan from ever re-queuing the image (`rescanArticle` skips locked images).
 */
export async function resolveArticleImageScan({
  articleId,
  imageId,
  nsfwLevel,
  userId,
}: {
  articleId: number;
  imageId: number;
  nsfwLevel: NsfwLevel;
  userId: number;
}): Promise<void> {
  // Guard against a mistyped/cross-article imageId silently overriding an
  // unrelated image: the image must be this article's cover or one of its
  // content-image connections.
  const [article, connection] = await Promise.all([
    dbRead.article.findUnique({ where: { id: articleId }, select: { coverId: true } }),
    dbRead.imageConnection.findFirst({
      where: { entityId: articleId, entityType: ImageConnectionType.Article, imageId },
      select: { imageId: true },
    }),
  ]);
  if (!article) throw throwNotFoundError(`No article with id ${articleId}`);
  if (article.coverId !== imageId && !connection)
    throw throwBadRequestError(`Image ${imageId} does not belong to article ${articleId}`);

  await resolveIngestionError({ id: imageId, nsfwLevel, userId });
  await recomputeArticleIngestion(articleId);
  await articlesSearchIndex.queueUpdate([
    { id: articleId, action: SearchIndexUpdateQueueAction.Update },
  ]);
}

const RESCAN_LIMIT = 3;
const RESCAN_WINDOW_SECONDS = CacheTTL.day; // 24 hours

const rescanImageSelect = {
  id: true,
  url: true,
  type: true,
  userId: true,
  ingestion: true,
  nsfwLevel: true,
  nsfwLevelLocked: true,
  blockedFor: true,
} as const;

/**
 * Whether an article rescan may re-queue this image. Skipped: one still in flight; a locked
 * rating, which is a moderator's override; a blocked image, since a clean scan result would lift
 * the block, which only a moderator decides; and an image someone other than the article's author
 * owns, which the author has no say over.
 */
function canRescanArticleImage(
  image: {
    userId: number;
    ingestion: ImageIngestionStatus;
    nsfwLevel: number;
    nsfwLevelLocked: boolean;
    blockedFor: string | null;
  },
  articleUserId: number
) {
  return (
    image.userId === articleUserId &&
    image.ingestion !== ImageIngestionStatus.Pending &&
    !image.nsfwLevelLocked &&
    !hasBlockMarker(image)
  );
}

/**
 * Rescan an article: re-queue its content images (see `canRescanArticleImage`) and re-submit
 * text moderation.
 *
 * Resets ingestion to Rescan, clears contentScannedAt, and lets the normal
 * webhook flow (image scan + text moderation) drive the article back to a
 * terminal ingestion state via recomputeArticleIngestion.
 */
export async function rescanArticle({
  id,
  isModerator,
}: GetByIdInput & { isModerator?: boolean }): Promise<void> {
  // --- Rate limit (owners only, mods bypass) ---
  const cacheKey = `${REDIS_KEYS.ARTICLE.RESCAN}:${id}` as const;
  if (!isModerator) {
    const attempts = (await redis.packed.get<number[]>(cacheKey)) ?? [];
    const cutoff = Date.now() - RESCAN_WINDOW_SECONDS * 1000;
    const recentAttempts = attempts.filter((t) => t > cutoff);

    if (recentAttempts.length >= RESCAN_LIMIT) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `This article can only be rescanned ${RESCAN_LIMIT} times per day. Please try again later.`,
      });
    }
  }

  // --- Fetch article ---
  const db = await getDbWithoutLag('article', id);
  const article = await db.article.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      content: true,
      title: true,
      coverId: true,
      status: true,
      scheduledAt: true,
    },
  });
  if (!article) throw throwNotFoundError(`No article with id ${id}`);
  if (article.content)
    await assertArticleContentUrlsUsable({
      content: article.content,
      storedContent: article.content,
      userId: article.userId,
      ownerId: article.userId,
    });

  // --- Reset ingestion state ---
  // Raw SQL to avoid bumping Article.updatedAt — a rescan is not a user-edit
  // and shouldn't reorder the "Recently Updated" feed.
  await dbWrite.$executeRaw`
    UPDATE "Article"
    SET ingestion = ${ArticleIngestionStatus.Rescan}::"ArticleIngestionStatus",
        "scanRequestedAt" = ${new Date()},
        "contentScannedAt" = NULL
    WHERE id = ${id}
  `;
  await preventReplicationLag('article', id);
  await preventReplicationLag('userArticles', article.userId);

  // Remove from search index immediately — article should not be searchable while rescanning.
  await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  // --- Re-link content images (picks up new images, queues Pending ones) ---
  if (article.content) {
    await linkArticleContentImages({
      articleId: id,
      content: article.content,
      userId: article.userId,
      ownerId: article.userId,
      coverId: article.coverId,
    });
  }

  // --- Re-queue already-processed images for rescan ---
  // The primary, not a replica: a block that landed seconds ago must not read as unblocked here.
  const connections = await dbWrite.imageConnection.findMany({
    where: { entityId: id, entityType: ImageConnectionType.Article },
    include: {
      image: {
        select: rescanImageSelect,
      },
    },
  });

  // Cover lives on `Article.coverId`, not in `ImageConnection`, so a broken
  // cover would never be re-queued without folding it in here.
  const cover = article.coverId
    ? await dbWrite.image.findUnique({
        where: { id: article.coverId },
        select: rescanImageSelect,
      })
    : null;

  const candidates = connections.map((conn) => conn.image);
  if (cover && !candidates.some((image) => image.id === cover.id)) candidates.push(cover);

  const imagesToIngest = candidates.filter((image) => canRescanArticleImage(image, article.userId));

  // Mark re-queued images non-terminal so the article reads as in-progress
  // (allComplete=false) and the status poll keeps running until they resolve.
  const imageIdsToIngest = imagesToIngest.map((image) => image.id);
  if (imageIdsToIngest.length) {
    await dbWrite.image.updateMany({
      where: { id: { in: imageIdsToIngest } },
      data: { ingestion: ImageIngestionStatus.Rescan },
    });
  }

  enqueueImageIngestion({
    images: imagesToIngest,
    name: 'article-rescan-image',
    userId: article.userId,
    lowPriority: true,
  });

  // --- Force a fresh text moderation scan ---
  // `forceRescan: true` bypasses the contentHash dedup in
  // `createXGuardModerationRequest` so a moderator-initiated rescan
  // produces a new orchestrator workflow even when the article's text
  // is unchanged.
  if (article.content && isPublicArticle(article)) {
    const textForModeration = [article.title, removeTags(article.content)]
      .filter(Boolean)
      .join(' ');

    await submitTextModerationOrScan({
      entityType: 'Article',
      entityId: id,
      force: true,
      xguard: () =>
        submitTextModeration({
          entityType: 'Article',
          entityId: id,
          content: textForModeration,
          labels: ['nsfw'],
          recordForReview: true,
          forceRescan: true,
          rearmRetries: true,
        }),
    }).catch((e) => {
      logToAxiom({
        type: 'error',
        name: 'article-rescan-text-moderation',
        message: (e as Error).message,
        articleId: id,
      }).catch();
    });
  }

  // --- Record rate limit attempt ---
  const attempts = (await redis.packed.get<number[]>(cacheKey)) ?? [];
  attempts.push(Date.now());
  const cutoff = Date.now() - RESCAN_WINDOW_SECONDS * 1000;
  await redis.packed.set(
    cacheKey,
    attempts.filter((t) => t > cutoff)
  );
  await redis.expire(cacheKey, RESCAN_WINDOW_SECONDS);

  // --- Lock ingestion state ---
  // Covers articles with no content and no images, where no webhook will fire
  // to advance state back to Scanned.
  await recomputeArticleIngestion(id).catch((e) =>
    handleLogError(e, 'article-rescan-recompute', { articleId: id })
  );

  // --- Log for observability ---
  logToAxiom({
    type: 'info',
    name: 'article-rescan',
    articleId: id,
    imageCount: connections.length,
    isModerator,
  }).catch();
}

/**
 * Retry scanning a single article image (owner or moderator). Re-queuing an
 * image runs it back through `ingestImage`, which re-fetches the blob — so a
 * transient `NotFound` (or `Error`) cover/content image can recover without
 * re-uploading. The scan webhook (`fanOutArticleImageUpdates`) recomputes the
 * article on completion for both cover and connection images, so no manual
 * recompute is needed here.
 */
export async function rescanArticleImage({
  articleId,
  imageId,
  userId,
  isModerator,
}: {
  articleId: number;
  imageId: number;
  userId: number;
  isModerator?: boolean;
}): Promise<void> {
  const db = await getDbWithoutLag('article', articleId);
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: { userId: true, coverId: true },
  });
  if (!article) throw throwNotFoundError(`No article with id ${articleId}`);
  if (article.userId !== userId && !isModerator)
    throw throwAuthorizationError('You cannot perform this action');

  // Image must belong to the article: its cover or a content-image connection.
  const belongs =
    article.coverId === imageId ||
    !!(await dbRead.imageConnection.findFirst({
      where: { entityId: articleId, entityType: ImageConnectionType.Article, imageId },
      select: { imageId: true },
    }));
  if (!belongs)
    throw throwBadRequestError(`Image ${imageId} does not belong to article ${articleId}`);

  // --- Rate limit (owners only, mods bypass) ---
  const cacheKey = `${REDIS_KEYS.ARTICLE.RESCAN}:image:${imageId}` as const;
  if (!isModerator) {
    const attempts = (await redis.packed.get<number[]>(cacheKey)) ?? [];
    const cutoff = Date.now() - RESCAN_WINDOW_SECONDS * 1000;
    if (attempts.filter((t) => t > cutoff).length >= RESCAN_LIMIT) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `This image can only be rescanned ${RESCAN_LIMIT} times per day. Please try again later.`,
      });
    }
  }

  const image = await dbWrite.image.findUnique({
    where: { id: imageId },
    select: rescanImageSelect,
  });
  if (!image) throw throwNotFoundError(`No image with id ${imageId}`);

  // An image already scanning needs nothing; any other refusal is the caller's to hear, and costs
  // no attempt.
  if (!canRescanArticleImage(image, article.userId)) {
    if (image.ingestion === ImageIngestionStatus.Pending) return;
    throw throwBadRequestError(
      'This image cannot be rescanned from the article. Remove it from the article if it is not needed.'
    );
  }

  // Flip to Rescan so the image is no longer terminal: getArticleScanStatus
  // then reports the article as in-progress (allComplete=false), which resumes
  // the 15s status poll so the eventual result loads without a manual refresh.
  await dbWrite.image.update({
    where: { id: image.id },
    data: { ingestion: ImageIngestionStatus.Rescan },
  });
  enqueueImageIngestion({
    images: [image],
    name: 'article-rescan-image',
    userId: article.userId,
    lowPriority: true,
  });

  const attempts = (await redis.packed.get<number[]>(cacheKey)) ?? [];
  attempts.push(Date.now());
  const cutoff = Date.now() - RESCAN_WINDOW_SECONDS * 1000;
  await redis.packed.set(
    cacheKey,
    attempts.filter((t) => t > cutoff)
  );
  await redis.expire(cacheKey, RESCAN_WINDOW_SECONDS);

  logToAxiom({
    type: 'info',
    name: 'article-rescan-image',
    articleId,
    imageId,
    isModerator,
  }).catch();
}

/** The seeded `civitai official` tag, or undefined until the row exists. */
export const getOfficialArticleTag = async () => {
  const systemTags = await getSystemTags();
  return systemTags.find((tag) => tag.name === OFFICIAL_ARTICLE_TAG.name);
};

// Article tags attach by NAME through `connectOrCreate`, so any client can send this string;
// drop it for every caller.
const withoutOfficialArticleTag = (
  tags: UpsertArticleInput['tags'],
  officialTag: { id: number } | undefined
) =>
  tags?.filter(
    (tag) =>
      tag.name.toLowerCase().trim() !== OFFICIAL_ARTICLE_TAG.name &&
      (!officialTag || tag.id !== officialTag.id)
  ) ?? undefined;

// `tagId` is resolved by the caller before its transaction opens: the lookup is a Redis read.
// Not `tag.service.addTags`/`disableTags`: neither takes a transaction client, and `disableTags`
// has no article branch.
const writeOfficialArticleTag = async ({
  articleId,
  tagId,
  isOfficial,
  db,
}: {
  articleId: number;
  tagId: number;
  isOfficial: boolean;
  db: Pick<Prisma.TransactionClient, 'tagsOnArticle'>;
}) => {
  if (isOfficial)
    await db.tagsOnArticle.createMany({ data: [{ articleId, tagId }], skipDuplicates: true });
  else await db.tagsOnArticle.deleteMany({ where: { articleId, tagId } });
};

/**
 * Mark an article as published by Civitai, or take that mark off.
 *
 * Mirrors `setModelOfficial` (model.service.ts), down to the moderator check: this is a
 * provenance claim, so the authority has to be a permission the user cannot give themselves.
 * Unlike the model, the `civitai official` tag is derived from the column, never the other
 * way round (see `withoutOfficialArticleTag`).
 *
 * 🔴 The `isModerator` argument is passed by the caller, so it is only as true as the
 * caller. The router mounts this on `moderatorProcedure`; keep it there. Do not add a
 * second caller that computes this flag from anything a request body carries.
 */
export const setArticleOfficial = async ({
  id,
  isOfficial,
  isModerator,
}: SetArticleOfficialInput & { isModerator: boolean }) => {
  if (!isModerator) throw throwAuthorizationError();

  const article = await dbRead.article.findUnique({ where: { id }, select: { id: true } });
  if (!article) throw throwNotFoundError(`No article with id ${id}`);

  const officialTag = await getOfficialArticleTag();
  const updated = await dbWrite.$transaction(async (tx) => {
    const row = await tx.article.update({
      where: { id },
      data: { isOfficial },
      select: { id: true, isOfficial: true },
    });
    if (officialTag)
      await writeOfficialArticleTag({ articleId: id, tagId: officialTag.id, isOfficial, db: tx });
    return row;
  });

  // The index document spreads `articleDetailSelect`, which now carries `isOfficial`, so
  // a stale document would keep serving the old provenance to search.
  await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  return updated;
};
