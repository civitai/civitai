import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import {
  imageNotRestrictedWhere,
  imageRestrictionSelect,
  withServableImage,
} from '~/server/common/image-visibility';
import { dbRead } from '~/server/db/client';
import { parseComicProjectMeta } from '~/server/schema/comics.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  isComicProjectHidden,
  isPanelTainted,
  readerPanelsWhere,
  withholdRestrictedPanelImages,
} from '~/server/services/comics/chapter-visibility';
import { hasEntityAccess } from '~/server/services/common.service';
import {
  BlockedByUsers,
  BlockedUsers,
  HiddenUsers,
} from '~/server/services/user-preferences.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import {
  hasPublicBrowsingLevel,
  hasSafeBrowsingLevel,
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import {
  Availability,
  ComicChapterStatus,
  ComicEngagementType,
  ComicGenre,
  ComicPanelStatus,
  ComicProjectStatus,
  ImageIngestionStatus,
  UserEngagementType,
} from '~/shared/utils/prisma/enums';
import { COMIC_ON_RED_ERROR } from '~/utils/comic-helpers';

// The public comic feed and reader, shared by the comics tRPC router and the public REST API.

/** The viewer the feed and reader evaluate for: `user` undefined is anonymous. */
export type PublicComicsCtx = Pick<Context, 'user'> & {
  features: Pick<Context['features'], 'isGreen'>;
};

// ALL comic counters come from `ComicProjectMetric` — a Postgres rollup
// recomputed from the source of truth by the `comicProjectMetrics` cron, exactly
// like ModelMetric/ArticleMetric:
//   - tips/followers/hides ← BuzzTip + ComicProjectEngagement
//   - readers/reads        ← ComicChapterRead (keyed by stable chapter id)
export async function getComicMetricRows(projectIds: number[]) {
  if (!projectIds.length)
    return new Map<
      number,
      {
        tippedCount: number;
        tippedAmountCount: number;
        followerCount: number;
        hiddenCount: number;
        readerCount: number;
        chapterReadCount: number;
      }
    >();
  const rows = await dbRead.comicProjectMetric.findMany({
    where: { comicProjectId: { in: projectIds } },
    select: {
      comicProjectId: true,
      tippedCount: true,
      tippedAmountCount: true,
      followerCount: true,
      hiddenCount: true,
      readerCount: true,
      chapterReadCount: true,
    },
  });
  return new Map(rows.map((r) => [r.comicProjectId, r]));
}

/**
 * Strip imageUrl from NSFW panels so they appear blocked on green domain.
 * Checks the panel's image nsfwLevel if available, otherwise falls back to
 * the chapter's aggregated nsfwLevel. If a panel has an imageUrl but no Image
 * record, it's treated as NSFW to be safe.
 *
 * On green: logged-in users see PG + PG13; logged-out users see PG only.
 */
export function stripNsfwPanelImages(
  chapters: {
    nsfwLevel: number;
    panels: { imageUrl: string | null; image?: { nsfwLevel: number } | null }[];
  }[],
  loggedIn: boolean
) {
  const passesSfwGate = loggedIn ? hasSafeBrowsingLevel : hasPublicBrowsingLevel;
  for (const chapter of chapters) {
    const chapterHasNsfw = Flags.intersects(chapter.nsfwLevel, nsfwBrowsingLevelsFlag);
    for (const panel of chapter.panels) {
      const panelNsfw = panel.image
        ? !passesSfwGate(panel.image.nsfwLevel)
        : panel.imageUrl
        ? true // Has image URL but no Image record — assume NSFW to be safe
        : chapterHasNsfw;
      if (panelNsfw && panel.imageUrl) {
        (panel as any).imageUrl = null;
      }
    }
  }
}

export const getPublicComicProjectsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  // For `Newest` the cursor is the trailing comic id (number).
  // For `MostFollowed` / `MostChapters` we need a compound cursor
  // — see the comment on `prefilteredIds` below — so we encode it
  // as `"<rank>:<id>"` and accept either shape here.
  cursor: z.union([z.number().int(), z.string()]).optional(),
  genre: z.nativeEnum(ComicGenre).optional(),
  period: z.enum(['Day', 'Week', 'Month', 'Year', 'AllTime']).optional(),
  sort: z.enum(['Newest', 'MostFollowed', 'MostChapters']).default('Newest'),
  // Sitewide 'Followed' semantics: comics authored by creators the viewer follows.
  followed: z.boolean().optional(),
  // Comics the viewer follows directly (per-comic Notify engagement).
  followedComics: z.boolean().optional(),
  userId: z.number().optional(),
  browsingLevel: z.number().int().min(0).optional(),
});

export async function getPublicComicProjects({
  input,
  ctx,
}: {
  input: z.infer<typeof getPublicComicProjectsSchema>;
  ctx: PublicComicsCtx;
}) {
  const { limit, cursor, genre, period, sort, followed, followedComics, userId, browsingLevel } =
    input;

  // Cursor handling: `Newest` carries the trailing id as a number,
  // `MostFollowed` / `MostChapters` carry a compound `<rank>:<id>`
  // string so we can do row-constructor comparison in raw SQL. Parse
  // once up-front and route each shape to the right code path.
  const isPrefilteredSort = sort === 'MostFollowed' || sort === 'MostChapters';
  let numericCursor: number | undefined;
  let compoundCursor: { rank: bigint; id: number } | undefined;
  if (cursor != null) {
    if (typeof cursor === 'number') {
      numericCursor = cursor;
    } else if (isPrefilteredSort && cursor.includes(':')) {
      const [rankStr, idStr] = cursor.split(':');
      const rank = BigInt(rankStr);
      const id = parseInt(idStr, 10);
      if (!Number.isNaN(id)) compoundCursor = { rank, id };
    } else {
      // String cursor passed on the Newest path (or malformed
      // compound) — best-effort parse as numeric id.
      const parsed = parseInt(cursor, 10);
      if (!Number.isNaN(parsed)) numericCursor = parsed;
    }
  }

  // Build where clause
  //
  // Visibility gates layered here (each one is a hard requirement —
  // the listing must NEVER expose content that fails any of them):
  //  - project is Active and not TOS-violated
  //  - author is not banned (User.bannedAt IS NULL)
  //  - project has at least one Published chapter with at least one
  //    Ready panel that carries an imageUrl
  //  - among the Ready panels of that chapter, none has an Image still
  //    awaiting review (`needsReview` set) or in a non-clean ingestion
  //    state (anything other than `Scanned`). Without this, panels
  //    whose underlying Image was flagged after the panel record went
  //    to `Ready` would still surface.
  const where: any = {
    status: ComicProjectStatus.Active,
    tosViolation: false,
    // Match the search-index WHERE clause so listing and search agree:
    // exclude system-user content (-1) and banned authors.
    userId: { not: -1 },
    user: { bannedAt: null },
    chapters: {
      some: {
        status: ComicChapterStatus.Published,
        panels: {
          some: {
            status: ComicPanelStatus.Ready,
            imageUrl: { not: null },
            image: {
              ingestion: ImageIngestionStatus.Scanned,
              needsReview: null,
              tosViolation: false,
            },
          },
          // No Ready panel may have an Image that's still under
          // review or blocked. We deliberately constrain to
          // `status === Ready` here: a chapter being actively
          // generated (Pending/Generating panels) is fine; we just
          // can't surface it if any of its Ready panels carries a
          // tainted Image.
          none: {
            status: ComicPanelStatus.Ready,
            OR: [
              { image: { needsReview: { not: null } } },
              { image: { tosViolation: true } },
              {
                image: {
                  ingestion: { not: ImageIngestionStatus.Scanned },
                },
              },
            ],
          },
        },
      },
    },
  };

  if (genre) where.genre = genre;

  // Hide comics authored by users the viewer has hidden/blocked, OR by
  // users who have blocked the viewer. Mirrors the comments-service
  // pattern (excludedUserIds = hidden ∪ blocked ∪ blockedBy). Caches are
  // empty for anonymous viewers so this is a no-op when ctx.user is null.
  const [hiddenUserIds, blockedByIds, blockedIds] = await Promise.all([
    HiddenUsers.getCached({ userId: ctx.user?.id }),
    BlockedByUsers.getCached({ userId: ctx.user?.id }),
    BlockedUsers.getCached({ userId: ctx.user?.id }),
  ]);
  const excludedUserIds = Array.from(
    new Set([...hiddenUserIds, ...blockedByIds, ...blockedIds].map((u) => u.id))
  );

  let followedUserIds: number[] | null = null;
  if (followed && ctx.user) {
    const follows = await dbRead.userEngagement.findMany({
      where: { userId: ctx.user.id, type: UserEngagementType.Follow },
      select: { targetUserId: true },
    });
    followedUserIds = follows
      .map((f) => f.targetUserId)
      .filter((id) => id !== -1 && !excludedUserIds.includes(id));
  }

  if (userId) {
    // Explicit author filter: if the requested author is on the exclusion
    // list (e.g. a stale link to a blocker's profile) or is the system
    // user (-1), force a no-match userId so the query returns nothing.
    const blocked =
      userId === -1 ||
      excludedUserIds.includes(userId) ||
      (followedUserIds !== null && !followedUserIds.includes(userId));
    where.userId = blocked ? { in: [] } : userId;
  } else if (followedUserIds !== null) {
    // An empty `in` list is correct here: following nobody means an empty feed.
    where.userId = { in: followedUserIds };
  } else if (excludedUserIds.length) {
    where.userId = { notIn: [...excludedUserIds, -1] };
  }
  // else: the project-level `userId: { not: -1 }` set above still
  // excludes the system user.

  // NSFW browsing level filter — compute allowed nsfwLevel values using bitwise match.
  //
  // Green domain cap mirrors `BrowsingLevelProvider`'s domain-forced
  // level: anonymous viewers can see PG only, logged-in viewers can
  // see PG + PG13. Anything the client requests is bitwise-AND'd
  // against this cap, so a hand-crafted request with a higher level
  // can't bypass the domain rule.
  const greenCap = ctx.user ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
  const requested = browsingLevel != null && browsingLevel > 0 ? browsingLevel : null;
  const effectiveBrowsingLevel = ctx.features.isGreen
    ? requested != null
      ? requested & greenCap
      : greenCap
    : requested;

  if (effectiveBrowsingLevel != null) {
    // Comic project nsfwLevel is a bit_or aggregate of all chapter levels.
    // A project with PG + R chapters has nsfwLevel=5. We must only allow projects
    // whose ALL bits fall within the allowed browsing level, not just "any overlap".
    const allowedNsfwLevels = [0]; // Always include unclassified (nsfwLevel=0)
    for (let i = 1; i <= 63; i++) {
      if ((i & ~effectiveBrowsingLevel) === 0) allowedNsfwLevels.push(i);
    }
    where.nsfwLevel = { in: allowedNsfwLevels };
  }

  if (period && period !== 'AllTime') {
    const periodMap: Record<string, number> = {
      Day: 1,
      Week: 7,
      Month: 30,
      Year: 365,
    };
    const days = periodMap[period];
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      where.updatedAt = { gte: since };
    }
  }

  if (followedComics && ctx.user) {
    where.engagements = {
      some: { userId: ctx.user.id, type: ComicEngagementType.Notify },
    };
  }

  // Build orderBy – always include id tie-breaker for stable cursor pagination.
  // `MostFollowed` and `MostChapters` need filtered relation counts —
  // engagements has multiple types (only `Notify` counts as a follow) and
  // chapters can be Draft or Published (only `Published` should count).
  // Prisma's `_count` in orderBy can't take a `where` filter, so for those
  // sorts we fetch the ID order via `$queryRaw` and let findMany hydrate
  // with the full visibility WHERE intact. `Newest` stays on the pure
  // Prisma path.
  const orderBy: any[] = [{ updatedAt: 'desc' }, { id: 'desc' }];
  let prefilteredIds: number[] | null = null;

  // Prefiltered sorts also carry the rank_value back so we can build
  // a `<rank>:<id>` cursor for the next page. Same row keyed in JS
  // so we don't have to re-query the rank for cursor encoding.
  let prefilteredRanked: { id: number; rank_value: bigint }[] | null = null;

  if (isPrefilteredSort) {
    // Overfetch to compensate for rows that the findMany WHERE later
    // rejects (panel-level review/TOS filters that we deliberately don't
    // duplicate in the raw query — keeping the visibility contract in
    // one place).
    const overfetch = (limit + 1) * 5;

    // Cursor predicate uses row-constructor comparison: `(rank, id) <
    // (cursorRank, cursorId)` returns every row strictly AFTER the
    // cursor in the sort order. This is what makes pagination
    // correct — a plain `cp.id < cursor` filter would re-show
    // high-rank low-id comics that were already on a previous page.
    const cursorFilter = compoundCursor
      ? Prisma.sql`AND (rank_value, cp.id) < (${compoundCursor.rank}::bigint, ${compoundCursor.id}::int)`
      : Prisma.empty;

    // Mirror the followed filters in the raw ranking query. Unlike the
    // panel-level visibility gates (rarely-rejecting, fine to post-filter),
    // these are highly selective — post-filtering alone would page through
    // mostly-rejected ids and cut the feed short after the first batch.
    const followedFilter =
      followedUserIds !== null
        ? Prisma.sql`AND cp."userId" IN (${
            followedUserIds.length > 0 ? Prisma.join(followedUserIds) : null
          })`
        : Prisma.empty;
    const followedComicsFilter =
      followedComics && ctx.user
        ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "ComicProjectEngagement" e
            WHERE e."projectId" = cp.id
              AND e."userId" = ${ctx.user.id}
              AND e.type = 'Notify'::"ComicEngagementType"
          )`
        : Prisma.empty;

    // Each query returns one row per comic with a `rank_value` column
    // computed by a correlated scalar subquery — for every `cp` row,
    // the subquery is evaluated against THAT row's projectId. PG
    // then orders by the per-row scalar, exactly like
    // `ORDER BY UPPER(name)` would. The CTE makes the rank_value
    // alias visible to the cursor predicate in the outer WHERE.
    if (sort === 'MostFollowed') {
      // Count only ComicProjectEngagement rows of type 'Notify'. Other
      // engagement types (Hide, None) still live in the same table but
      // don't represent followers.
      prefilteredRanked = await dbRead.$queryRaw<{ id: number; rank_value: bigint }[]>(
        Prisma.sql`
          WITH ranked AS (
            SELECT
              cp.id,
              (
                SELECT COUNT(*) FROM "ComicProjectEngagement"
                WHERE "projectId" = cp.id AND type = 'Notify'::"ComicEngagementType"
              ) AS rank_value
            FROM "ComicProject" cp
            LEFT JOIN "User" u ON u.id = cp."userId"
            WHERE cp.status = 'Active'::"ComicProjectStatus"
              AND cp."tosViolation" = false
              AND cp."userId" != -1
              AND u."bannedAt" IS NULL
              ${followedFilter}
              ${followedComicsFilter}
          )
          SELECT id, rank_value
          FROM ranked cp
          WHERE TRUE
            ${cursorFilter}
          ORDER BY rank_value DESC, cp.id DESC
          LIMIT ${overfetch}
        `
      );
    } else {
      // Count only Published chapters — Draft / scheduled chapters
      // shouldn't influence the "Most Chapters" ranking since readers
      // can't see them anyway.
      prefilteredRanked = await dbRead.$queryRaw<{ id: number; rank_value: bigint }[]>(
        Prisma.sql`
          WITH ranked AS (
            SELECT
              cp.id,
              (
                SELECT COUNT(*) FROM "ComicChapter"
                WHERE "projectId" = cp.id AND status = 'Published'::"ComicChapterStatus"
              ) AS rank_value
            FROM "ComicProject" cp
            LEFT JOIN "User" u ON u.id = cp."userId"
            WHERE cp.status = 'Active'::"ComicProjectStatus"
              AND cp."tosViolation" = false
              AND cp."userId" != -1
              AND u."bannedAt" IS NULL
              ${followedFilter}
              ${followedComicsFilter}
          )
          SELECT id, rank_value
          FROM ranked cp
          WHERE TRUE
            ${cursorFilter}
          ORDER BY rank_value DESC, cp.id DESC
          LIMIT ${overfetch}
        `
      );
    }
    prefilteredIds = prefilteredRanked.map((r) => r.id);
  }

  const projects = await dbRead.comicProject.findMany({
    // For filtered sorts, restrict to the pre-sorted IDs from raw SQL.
    // findMany still applies the full visibility WHERE for safety; the
    // raw SQL only constrains ordering.
    where: prefilteredIds ? { ...where, id: { in: prefilteredIds } } : where,
    // For prefiltered sorts, take everything that matched (already capped
    // at `overfetch` upstream). We trim to `limit + 1` after re-sorting.
    take: prefilteredIds ? undefined : limit + 1,
    ...(numericCursor != null && !prefilteredIds ? { cursor: { id: numericCursor }, skip: 1 } : {}),
    orderBy: prefilteredIds ? undefined : orderBy,
    select: {
      id: true,
      name: true,
      description: true,
      coverImage: {
        select: {
          id: true,
          url: true,
          ...imageRestrictionSelect,
          type: true,
          metadata: true,
          width: true,
          height: true,
          name: true,
          hash: true,
        },
      },
      heroImage: {
        select: {
          id: true,
          url: true,
          ...imageRestrictionSelect,
          type: true,
          metadata: true,
          width: true,
          height: true,
          name: true,
          hash: true,
        },
      },
      heroImagePosition: true,
      genre: true,
      nsfwLevel: true,
      updatedAt: true,
      user: {
        select: userWithCosmeticsSelect,
      },
      chapters: {
        where: { status: ComicChapterStatus.Published },
        select: {
          projectId: true,
          position: true,
          name: true,
          publishedAt: true,
          // Mirror the project-level WHERE: only Ready panels whose
          // Image is fully clean (Scanned, no review, no TOS) count
          // toward `readyPanelCount` and the thumbnail sample.
          // Without this, a project that passes the gate on one
          // clean panel can still ship a thumbnail/preview drawn
          // from a tainted Ready panel.
          _count: {
            select: {
              panels: {
                where: {
                  status: ComicPanelStatus.Ready,
                  imageUrl: { not: null },
                  image: {
                    ingestion: ImageIngestionStatus.Scanned,
                    needsReview: null,
                    tosViolation: false,
                  },
                },
              },
            },
          },
          panels: {
            where: {
              status: ComicPanelStatus.Ready,
              imageUrl: { not: null },
              image: {
                ingestion: ImageIngestionStatus.Scanned,
                needsReview: null,
                tosViolation: false,
                nsfwLevel: { not: NsfwLevel.Blocked },
                ...imageNotRestrictedWhere({ viewerId: ctx.user?.id }),
              },
            },
            take: 1,
            orderBy: { position: 'asc' },
            select: { imageUrl: true },
          },
        },
        orderBy: { position: 'desc' },
      },
    },
  });

  // For prefiltered sorts the findMany result came back in arbitrary
  // (id-ordered) order — restore the raw-SQL ranking by matching each
  // project against its position in `prefilteredIds`. Either way the
  // page is trimmed to `limit` and the cursor is its last shown item.
  if (prefilteredIds) {
    const orderMap = new Map(prefilteredIds.map((id, i) => [id, i]));
    projects.sort(
      (a, b) =>
        (orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  // nextCursor type depends on the sort:
  //  - Newest:        numeric (trailing id), back-compat
  //  - MostFollowed / MostChapters: `<rank>:<id>` string so the next
  //    page can do a row-constructor comparison against the same
  //    (rank, id) tuple this page ended on.
  let nextCursor: number | string | undefined;
  if (projects.length > limit) {
    if (prefilteredIds && prefilteredRanked) {
      // Cursor = LAST shown item's (rank, id). The next page asks
      // for rows strictly AFTER it in the sort order, so there's no
      // overlap (the old `cp.id < cursor` filter was the source of
      // the repeats users were seeing).
      const lastShown = projects[limit - 1];
      const rankRow = prefilteredRanked.find((r) => r.id === lastShown.id);
      if (rankRow) {
        nextCursor = `${rankRow.rank_value.toString()}:${rankRow.id}`;
      }
      projects.length = limit;
    } else {
      // The last comic shown: the next page's `cursor` + `skip: 1` starts right after it.
      projects.length = limit;
      nextCursor = projects[limit - 1].id;
    }
  }

  // All counters from `ComicProjectMetric` (Postgres). See `getComicMetricRows`.
  const projectIds = projects.map((p) => p.id);
  const metricRows = await getComicMetricRows(projectIds);

  const items = projects.map((p) => {
    const readyPanelCount = p.chapters.reduce((sum, ch) => sum + ch._count.panels, 0);
    const chapterCount = p.chapters.length;
    const { coverImage: servableCover } = withServableImage(p, 'coverImage', ctx.user?.id);
    const { heroImage: servableHero } = withServableImage(p, 'heroImage', ctx.user?.id);
    const rawThumbnailUrl =
      servableCover?.url ??
      p.chapters.flatMap((ch) => ch.panels).find((panel) => panel.imageUrl)?.imageUrl ??
      null;

    // On green, strip NSFW cover/hero/thumbnail images.
    // Logged-in viewers see PG + PG13; logged-out viewers see PG only.
    const passesSfwGate = ctx.user ? hasSafeBrowsingLevel : hasPublicBrowsingLevel;
    const coverImage =
      ctx.features.isGreen && servableCover && !passesSfwGate(servableCover.nsfwLevel)
        ? null
        : servableCover;
    const heroImage =
      ctx.features.isGreen && servableHero && !passesSfwGate(servableHero.nsfwLevel)
        ? null
        : servableHero;
    // Project nsfwLevel is bit_or of all chapters. Strip thumbnail if any R+
    // bit is present, or (for logged-out viewers) any PG13 bit is present.
    const thumbnailUrl =
      ctx.features.isGreen &&
      (Flags.intersects(p.nsfwLevel, nsfwBrowsingLevelsFlag) || !passesSfwGate(p.nsfwLevel))
        ? null
        : rawThumbnailUrl;

    // Latest 3 published chapters
    const latestChapters = p.chapters.slice(0, 3).map((ch) => ({
      projectId: ch.projectId,
      position: ch.position,
      name: ch.name,
      publishedAt: ch.publishedAt,
    }));

    const metric = metricRows.get(p.id) ?? null;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      thumbnailUrl,
      coverImage,
      heroImage,
      genre: p.genre,
      nsfwLevel: p.nsfwLevel,
      readyPanelCount,
      chapterCount,
      latestChapters,
      // All counters from `ComicProjectMetric` (Postgres).
      followerCount: metric?.followerCount ?? 0,
      readerCount: metric?.readerCount ?? 0,
      chapterReadCount: metric?.chapterReadCount ?? 0,
      hiddenCount: metric?.hiddenCount ?? 0,
      tippedCount: metric?.tippedCount ?? 0,
      tippedAmount: metric?.tippedAmountCount ?? 0,
      user: p.user,
      updatedAt: p.updatedAt,
    };
  });

  return { items, nextCursor };
}

export async function getPublicComicForReader({
  input,
  ctx,
}: {
  input: { id: number };
  ctx: PublicComicsCtx;
}) {
  // Cheap meta read first — we need to know who owns this project
  // before we can decide whether to pull non-Published chapters in
  // the SQL select. Doing this in one query would force us to fall
  // back to the old `ctx.user != null` shortcut, which leaks draft
  // rows for every logged-in viewer, not just owners/mods.
  const projectMeta = await dbRead.comicProject.findUnique({
    where: { id: input.id },
    select: { userId: true, status: true },
  });
  if (!projectMeta || projectMeta.status === ComicProjectStatus.Deleted) {
    throw throwNotFoundError('Comic not found');
  }
  const isModerator = ctx.user?.isModerator === true;
  const isOwner = ctx.user != null && ctx.user.id === projectMeta.userId;
  // Only the owner or a moderator gets non-Published chapters from the
  // SQL select. Public reader viewers (anonymous OR logged-in non-owners)
  // never see drafts on this endpoint.
  const canSeeAllChapters = isOwner || isModerator;

  const project = await dbRead.comicProject.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      name: true,
      description: true,
      userId: true,
      coverImage: { select: { id: true, url: true, ...imageRestrictionSelect } },
      heroImage: { select: { id: true, url: true, ...imageRestrictionSelect } },
      heroImagePosition: true,
      meta: true,
      genre: true,
      nsfwLevel: true,
      status: true,
      tosViolation: true,
      publishedAt: true,
      user: {
        select: { ...userWithCosmeticsSelect, bannedAt: true },
      },
      chapters: {
        // Public reader: only Published chapters reach the SQL response
        // for non-owner / non-mod viewers. Owners and mods can pull
        // all statuses (drafts included) so they can preview the
        // page or moderate flagged content.
        ...(!canSeeAllChapters ? { where: { status: ComicChapterStatus.Published } } : {}),
        orderBy: { position: 'asc' },
        select: {
          id: true,
          projectId: true,
          position: true,
          name: true,
          status: true,
          nsfwLevel: true,
          publishedAt: true,
          availability: true,
          earlyAccessConfig: true,
          earlyAccessEndsAt: true,
          panels: {
            where: readerPanelsWhere,
            orderBy: { position: 'asc' },
            select: {
              id: true,
              imageUrl: true,
              prompt: true,
              position: true,
              // Pull moderation-relevant Image fields so non-owner/mod
              // viewers can be denied chapters that have any panel
              // image still in review or with a TOS / blocked
              // ingestion state. Without this a `Ready` panel whose
              // underlying Image was flagged AFTER scan would still
              // surface here.
              image: {
                select: {
                  id: true,
                  ...imageRestrictionSelect,
                  hash: true,
                  width: true,
                  height: true,
                  ingestion: true,
                  blockedFor: true,
                  needsReview: true,
                  tosViolation: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!project || (await isComicProjectHidden(project, ctx.user))) {
    throw throwNotFoundError('Comic not found');
  }

  // Check if viewer is the owner or a moderator
  const canViewDrafts =
    ctx.user != null && (project.userId === ctx.user.id || ctx.user.isModerator === true);

  // Filter out draft chapters for non-owner, non-mod viewers, chapters
  // with no ready panels, AND chapters whose Ready panels carry any
  // Image still in review or in a non-clean ingestion state. The
  // listing endpoint applies an equivalent filter at the query layer
  // so a chapter held back here also won't make a project discoverable
  // through the feed. Owners and mods bypass the review filter so
  // they can still navigate their own comic and moderate flagged
  // content.
  const filteredChapters = project.chapters.filter((ch) => {
    if (ch.panels.length === 0) return false;
    if (ch.status !== ComicChapterStatus.Published && !canViewDrafts) return false;
    return canViewDrafts || !ch.panels.some(isPanelTainted);
  });

  // Public viewers get a 404 if nothing's visible. Owners and mods
  // still get the page even when empty — they may be previewing a
  // brand-new project or reviewing flagged content where every
  // chapter has been pulled by the moderation gates.
  if (filteredChapters.length === 0 && !canViewDrafts) {
    throw throwNotFoundError('Comic not found');
  }

  // After every visibility gate, so only a comic red would actually serve gets the red prompt;
  // anything else still 404s.
  if (
    ctx.features.isGreen &&
    project.nsfwLevel !== 0 &&
    Flags.intersects(project.nsfwLevel, nsfwBrowsingLevelsFlag)
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: COMIC_ON_RED_ERROR });
  }

  // Check early access for chapters that are currently in EA
  const now = new Date();
  const eaChapters = filteredChapters.filter(
    (ch) =>
      ch.availability === Availability.EarlyAccess &&
      ch.earlyAccessEndsAt &&
      ch.earlyAccessEndsAt > now
  );

  const accessMap = new Map<number, boolean>();
  if (eaChapters.length > 0 && !canViewDrafts) {
    const eaChapterIds = eaChapters.map((ch) => ch.id);
    const accessResults = await hasEntityAccess({
      entityType: 'ComicChapter',
      entityIds: eaChapterIds,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });
    for (const result of accessResults) {
      accessMap.set(result.entityId, result.hasAccess);
    }
  }

  const chapters = filteredChapters.map((ch) => {
    const isEa =
      ch.availability === Availability.EarlyAccess &&
      ch.earlyAccessEndsAt &&
      ch.earlyAccessEndsAt > now;
    const isLocked = isEa && !canViewDrafts && !accessMap.get(ch.id);
    const eaConfig = ch.earlyAccessConfig as {
      buzzPrice: number;
      timeframe: number;
    } | null;

    return {
      id: ch.id,
      projectId: ch.projectId,
      position: ch.position,
      name: ch.name,
      status: ch.status,
      nsfwLevel: ch.nsfwLevel,
      publishedAt: ch.publishedAt,
      availability: ch.availability,
      earlyAccessConfig: eaConfig,
      earlyAccessEndsAt: ch.earlyAccessEndsAt,
      panelCount: ch.panels.length,
      // Strip panels server-side for locked EA chapters (security)
      panels: isLocked ? [] : ch.panels,
    };
  });

  withholdRestrictedPanelImages(chapters, ctx.user?.id);
  // On green, strip imageUrl from NSFW panels so they appear blocked.
  if (ctx.features.isGreen) {
    stripNsfwPanelImages(chapters, !!ctx.user);
  }

  // All counters from `ComicProjectMetric` (Postgres). See `getComicMetricRows`.
  const metric = (await getComicMetricRows([project.id])).get(project.id) ?? null;
  const passesSfwGate = ctx.user ? hasSafeBrowsingLevel : hasPublicBrowsingLevel;
  const { coverImage } = withServableImage(project, 'coverImage', ctx.user?.id);
  const { heroImage } = withServableImage(project, 'heroImage', ctx.user?.id);

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    nsfwLevel: project.nsfwLevel,
    meta: parseComicProjectMeta(project.meta),
    coverImage:
      ctx.features.isGreen && coverImage && !passesSfwGate(coverImage.nsfwLevel)
        ? null
        : coverImage,
    heroImage:
      ctx.features.isGreen && heroImage && !passesSfwGate(heroImage.nsfwLevel) ? null : heroImage,
    heroImagePosition: project.heroImagePosition,
    user: project.user,
    isOwnerOrMod: canViewDrafts,
    tosViolation: project.tosViolation,
    tippedAmountCount: metric?.tippedAmountCount ?? 0,
    tippedCount: metric?.tippedCount ?? 0,
    followerCount: metric?.followerCount ?? 0,
    readerCount: metric?.readerCount ?? 0,
    chapterReadCount: metric?.chapterReadCount ?? 0,
    hiddenCount: metric?.hiddenCount ?? 0,
    chapters,
  };
}
