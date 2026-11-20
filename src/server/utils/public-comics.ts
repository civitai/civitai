import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { challengeCoverWhere } from '~/server/common/image-visibility';
import {
  getCoverBrowsingLevels,
  publicCoverImageSelect,
  toPublicCoverImage,
} from '~/server/utils/public-cover-image';
import { dbRead } from '~/server/db/client';
import { parseComicProjectMeta } from '~/server/schema/comics.schema';
import {
  getPublicComicForReader,
  getPublicComicProjects,
  type PublicComicsCtx,
} from '~/server/services/comics/public-comics.service';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import { apiBrowsingLevel } from '~/server/utils/browsing-level';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { Availability, type ComicGenre } from '~/shared/utils/prisma/enums';
import { slugitOr } from '~/utils/string-helpers';

// The public REST API for comics. Every request is evaluated as an anonymous civitai.red visitor,
// then narrowed to the caller's browsing level, so the default (PG) response can sit in the shared
// cache.

const anonymous: PublicComicsCtx = { user: undefined, features: { isGreen: false } };

const PAGE_WIDTH = 1600;

/** Every bit of `level` is allowed. A comic at 0 (not yet rated) passes, as in the site's feed. */
const fits = (level: number, browsingLevel: number) => (level & ~browsingLevel) === 0;
const imageFits = (level: number, browsingLevel: number) =>
  level !== 0 && fits(level, browsingLevel);

/** A comic with any mature chapter lives on the red site. */
const comicUrl = (id: number, name: string, nsfwLevel: number) =>
  `${getBaseUrl(
    Flags.intersects(nsfwLevel, nsfwBrowsingLevelsFlag) ? 'red' : undefined
  )}/comics/${id}/${slugitOr(name, 'comic')}`;
const chapterUrl = (
  comic: { id: number; name: string; nsfwLevel: number },
  number: number,
  chapterName: string
) =>
  `${comicUrl(comic.id, comic.name, comic.nsfwLevel)}/${number}/${slugitOr(
    chapterName,
    'chapter'
  )}`;

/**
 * The public `coverImage` for each id. A cover is any image the creator picked, so unlike a page it
 * has not passed the reader's panel check.
 */
async function publicCovers(ids: (number | undefined)[], browsingLevel: number) {
  const wanted = ids.filter((id): id is number => id != null);
  if (!wanted.length) return new Map<number, ReturnType<typeof toPublicCoverImage>>();
  const rows = await dbRead.image.findMany({
    where: { AND: [{ id: { in: wanted } }, challengeCoverWhere()] },
    select: publicCoverImageSelect,
  });
  // Narrowed to the held gallery level of a cover's post's model, as /collections does.
  const coverLevel = await getCoverBrowsingLevels(rows, browsingLevel);
  return new Map(rows.map((row) => [row.id, toPublicCoverImage(row, coverLevel(row))]));
}

const coverImage = (
  image: { id: number } | null | undefined,
  covers: Map<number, ReturnType<typeof toPublicCoverImage>>
) => (image ? covers.get(image.id) ?? null : null);

/** The feed's cursor for `sort`, or null when it is malformed: a comic id, or "<rank>:<id>". */
export function parseComicsCursor(
  cursor: string,
  sort: 'Newest' | 'MostFollowed' | 'MostChapters'
) {
  const id = (value: string) => {
    const n = Number(value);
    return n > 0 && n <= 2147483647 ? n : null;
  };
  if (sort === 'Newest') return /^\d{1,10}$/.test(cursor) ? id(cursor) : null;
  const match = /^(\d{1,18}):(\d{1,10})$/.exec(cursor);
  return match && id(match[2]) != null ? cursor : null;
}

const isInEarlyAccess = (
  chapter: { availability: Availability; earlyAccessEndsAt: Date | null },
  now: Date
) =>
  chapter.availability === Availability.EarlyAccess &&
  !!chapter.earlyAccessEndsAt &&
  chapter.earlyAccessEndsAt > now;

/**
 * The caller's browsing level. The default, PG, is the same in every region, so it stays edge-cached.
 * `nsfw` widens it, clamped to SFW in a restricted region; that body depends on the region, which the
 * shared cache does not key on, so it is `private, no-store`.
 */
export function comicsBrowsingLevel(req: NextApiRequest, res: NextApiResponse, nsfw?: boolean) {
  if (!nsfw) return publicBrowsingLevelsFlag;
  res.setHeader('Cache-Control', 'private, no-store');
  return apiBrowsingLevel(req);
}

/**
 * The checks every comics route makes before its own work: the comics feature flag, as the site
 * evaluates it for a signed-out visitor, and the per-client rate limit. Returns false once it has
 * answered.
 */
export async function admitComicsRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  if (!getFeatureFlagsLazy({ req }).comicCreator) {
    // A cached 404 would outlive the flag being turned on.
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  const rateLimit = await checkPublicApiRateLimit({ req, family: 'comics', userId: user?.id });
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return false;
  }
  return true;
}

export async function listPublicComics({
  limit,
  cursor,
  sort,
  period,
  genre,
  username,
  browsingLevel,
}: {
  limit: number;
  cursor?: number | string;
  sort: 'Newest' | 'MostFollowed' | 'MostChapters';
  period?: 'Day' | 'Week' | 'Month' | 'Year' | 'AllTime';
  genre?: ComicGenre;
  username?: string;
  browsingLevel: number;
}) {
  let userId: number | undefined;
  if (username) {
    const user = await dbRead.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) return { items: [], nextCursor: undefined };
    userId = user.id;
  }

  const { items, nextCursor } = await getPublicComicProjects({
    input: { limit, cursor, sort, period, genre, userId, browsingLevel },
    ctx: anonymous,
  });

  const [metas, covers] = await Promise.all([
    dbRead.comicProject.findMany({
      where: { id: { in: items.map((item) => item.id) } },
      select: { id: true, meta: true },
    }),
    publicCovers(
      items.map((item) => item.coverImage?.id),
      browsingLevel
    ),
  ]);
  const allowDownload = new Map(
    metas.map(({ id, meta }) => [id, parseComicProjectMeta(meta)?.allowDownload === true])
  );

  return {
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      genre: item.genre,
      url: comicUrl(item.id, item.name, item.nsfwLevel),
      nsfwLevel: item.nsfwLevel,
      coverImage: coverImage(item.coverImage, covers),
      user: { username: item.user.username },
      chapterCount: item.chapterCount,
      followerCount: item.followerCount,
      readerCount: item.readerCount,
      updatedAt: item.updatedAt,
      allowDownload: allowDownload.get(item.id) ?? false,
    })),
    nextCursor: nextCursor != null ? String(nextCursor) : undefined,
  };
}

/** The comic as the reader serves it, or null when it is not public or is above `browsingLevel`. */
async function readComic(id: number, browsingLevel: number) {
  try {
    const comic = await getPublicComicForReader({ input: { id }, ctx: anonymous });
    return fits(comic.nsfwLevel, browsingLevel) ? comic : null;
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

export async function getPublicComic(id: number, browsingLevel: number, now = new Date()) {
  const comic = await readComic(id, browsingLevel);
  if (!comic) return null;
  const covers = await publicCovers([comic.coverImage?.id], browsingLevel);
  return {
    id: comic.id,
    name: comic.name,
    description: comic.description,
    url: comicUrl(comic.id, comic.name, comic.nsfwLevel),
    nsfwLevel: comic.nsfwLevel,
    allowDownload: comic.meta?.allowDownload === true,
    coverImage: coverImage(comic.coverImage, covers),
    user: { username: comic.user.username },
    followerCount: comic.followerCount,
    readerCount: comic.readerCount,
    chapters: comic.chapters
      .filter((chapter) => fits(chapter.nsfwLevel, browsingLevel))
      .map((chapter) => ({
        number: chapter.position + 1,
        name: chapter.name,
        publishedAt: chapter.publishedAt,
        nsfwLevel: chapter.nsfwLevel,
        pageCount: chapter.panelCount,
        earlyAccessEndsAt: isInEarlyAccess(chapter, now) ? chapter.earlyAccessEndsAt : null,
        url: chapterUrl(comic, chapter.position + 1, chapter.name),
      })),
  };
}

export async function getPublicComicChapter(
  id: number,
  number: number,
  browsingLevel: number,
  now = new Date()
) {
  const comic = await readComic(id, browsingLevel);
  const chapter = comic?.chapters.find((ch) => ch.position === number - 1);
  if (!comic || !chapter || !fits(chapter.nsfwLevel, browsingLevel))
    return { status: 404 as const };
  // Defensive: a chapter whose panels the reader emptied is locked; never answer it with no pages.
  const locked = chapter.panels.length === 0 && chapter.panelCount > 0;
  if (isInEarlyAccess(chapter, now) || locked)
    return { status: 403 as const, earlyAccessEndsAt: chapter.earlyAccessEndsAt };

  return {
    status: 200 as const,
    chapter: {
      comicId: comic.id,
      series: comic.name,
      number,
      name: chapter.name,
      writer: comic.user.username,
      nsfwLevel: chapter.nsfwLevel,
      publishedAt: chapter.publishedAt,
      allowDownload: comic.meta?.allowDownload === true,
      url: chapterUrl(comic, number, chapter.name),
      pages: chapter.panels.map((panel, i) => {
        const level = panel.image?.nsfwLevel ?? 0;
        return {
          number: i + 1,
          url:
            panel.imageUrl && imageFits(level, browsingLevel)
              ? getEdgeUrl(panel.imageUrl, { width: PAGE_WIDTH, name: String(panel.id) })
              : null,
          width: panel.image?.width ?? null,
          height: panel.image?.height ?? null,
          nsfwLevel: level,
        };
      }),
    },
  };
}
