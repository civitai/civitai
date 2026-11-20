import { beforeEach, describe, expect, it, vi } from 'vitest';

// A region restricted since 2020, read when region-blocking loads.
vi.hoisted(() => {
  process.env.REGION_RESTRICTION_CONFIG = 'GB:2020-01-01';
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { NsfwLevel } from '~/server/common/enums';
import { minorContentNotRestrictedWhere } from '~/server/utils/minor-content-gate.sql';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  comicsBrowsingLevel,
  getPublicComic,
  getPublicComicChapter,
  listPublicComics,
  parseComicsCursor,
} from '~/server/utils/public-comics';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  Availability,
  ComicChapterStatus,
  ComicProjectStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';

/** Drives the real reader service over mocked database rows. */

const OWNER = 990000001;
const COMIC = 990000100;
// The reader service reads the real clock, so early-access dates sit far from it.
const NOW = new Date();
const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');

const cleanImage = (id: number, nsfwLevel: number, extra: Record<string, unknown> = {}) => ({
  id,
  nsfwLevel,
  modelRestricted: false,
  userId: OWNER,
  hash: null,
  width: 800,
  height: 1200,
  ingestion: ImageIngestionStatus.Scanned,
  needsReview: null,
  tosViolation: false,
  ...extra,
});

const panel = (id: number, nsfwLevel: number, extra: Record<string, unknown> = {}) => ({
  id,
  imageUrl: `img-${id}`,
  prompt: '',
  position: id,
  image: cleanImage(id, nsfwLevel, extra),
});

const chapter = (position: number, nsfwLevel: number, extra: Record<string, unknown> = {}) => ({
  id: 990000200 + position,
  projectId: COMIC,
  position,
  name: `Chapter ${position + 1}`,
  status: ComicChapterStatus.Published,
  nsfwLevel,
  publishedAt: new Date('2026-11-01T00:00:00Z'),
  availability: Availability.Public,
  earlyAccessConfig: null,
  earlyAccessEndsAt: null,
  panels: [panel(990000300 + position * 10, nsfwLevel)],
  ...extra,
});

function comic(extra: Record<string, unknown> = {}) {
  return {
    id: COMIC,
    name: 'My Comic',
    description: null,
    userId: OWNER,
    coverImage: null,
    heroImage: null,
    heroImagePosition: null,
    meta: {},
    genre: null,
    nsfwLevel: NsfwLevel.PG,
    status: ComicProjectStatus.Active,
    tosViolation: false,
    publishedAt: new Date('2026-11-01T00:00:00Z'),
    user: { id: OWNER, username: 'creator', bannedAt: null, image: null, deletedAt: null },
    chapters: [chapter(0, NsfwLevel.PG)],
    ...extra,
  };
}

function serve(row: ReturnType<typeof comic>) {
  dbMock.dbRead.comicProject.findUnique.mockImplementation(async ({ select }) =>
    select && 'chapters' in select ? row : { userId: row.userId, status: row.status }
  );
}

beforeEach(() => {
  dbMock.dbRead.comicProject.findUnique.mockReset();
  dbMock.dbRead.comicProject.findMany.mockReset().mockResolvedValue([]);
  dbMock.dbRead.user.findUnique.mockReset().mockResolvedValue(null);
  dbMock.dbRead.image.findMany.mockReset().mockResolvedValue([]);
});

describe('a comic the public reader would not serve is not found', () => {
  it.each([
    ['in TOS violation', { tosViolation: true }],
    ['not published', { publishedAt: null }],
    ['by a banned creator', { user: { ...comic().user, bannedAt: new Date('2026-01-01') } }],
    ['deleted', { status: ComicProjectStatus.Deleted }],
  ])('%s', async (_, extra) => {
    serve(comic(extra));
    expect(await getPublicComic(COMIC, allBrowsingLevelsFlag, NOW)).toBeNull();
    expect(await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW)).toEqual({
      status: 404,
    });
  });

  it('serves the same comic when nothing is wrong with it', async () => {
    serve(comic());
    expect((await getPublicComic(COMIC, allBrowsingLevelsFlag, NOW))?.id).toBe(COMIC);
  });
});

describe('browsing level', () => {
  const mature = () =>
    comic({ nsfwLevel: NsfwLevel.PG | NsfwLevel.R, chapters: [chapter(0, NsfwLevel.R)] });

  it('hides a comic with any chapter above the level asked for', async () => {
    serve(mature());
    expect(await getPublicComic(COMIC, publicBrowsingLevelsFlag, NOW)).toBeNull();
    expect((await getPublicComicChapter(COMIC, 1, publicBrowsingLevelsFlag, NOW)).status).toBe(404);
  });

  it('serves it, pages included, when the caller asks for mature levels', async () => {
    serve(mature());
    const result = await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW);
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.chapter.pages[0].url).toMatch(/img-990000300/);
  });
});

describe('chapter level', () => {
  it('leaves out a chapter above the level even when the comic level lags behind', async () => {
    serve(comic({ chapters: [chapter(0, NsfwLevel.PG), chapter(1, NsfwLevel.R)] }));
    const listed = await getPublicComic(COMIC, publicBrowsingLevelsFlag, NOW);
    expect(listed?.chapters.map((c) => c.number)).toEqual([1]);
    expect((await getPublicComicChapter(COMIC, 2, publicBrowsingLevelsFlag, NOW)).status).toBe(404);
  });
});

describe('covers', () => {
  const COVER = 990000400;
  const publicRow = (extra: Record<string, unknown> = {}) => ({
    id: COVER,
    url: 'cover-url',
    type: 'image',
    width: 800,
    height: 600,
    nsfwLevel: NsfwLevel.PG,
    ingestion: ImageIngestionStatus.Scanned,
    scannedAt: new Date('2026-11-01T00:00:00Z'),
    tosViolation: false,
    needsReview: null,
    blockedFor: null,
    poi: false,
    minor: false,
    acceptableMinor: false,
    postId: null,
    ...extra,
  });
  const withCover = (row: Record<string, unknown>) => {
    dbMock.dbRead.image.findMany.mockResolvedValue([row]);
    serve(
      comic({
        coverImage: {
          id: COVER,
          url: 'cover-url',
          nsfwLevel: row.nsfwLevel,
          modelRestricted: false,
          userId: OWNER,
        },
      })
    );
  };

  it('serves a cover that passes the public cover rule, resized', async () => {
    withCover(publicRow());
    const url = (await getPublicComic(COMIC, publicBrowsingLevelsFlag, NOW))?.coverImage?.url;
    expect(url).toMatch(/cover-url/);
    expect(url).toMatch(/width=450/);
  });

  it.each([
    ['above the level', { nsfwLevel: NsfwLevel.R }],
    ['unrated', { nsfwLevel: 0 }],
    ['held for review', { needsReview: 'minor' }],
    ['not yet scanned', { ingestion: ImageIngestionStatus.Pending }],
    ['flagged as a minor', { minor: true }],
  ])('drops a cover %s', async (_, extra) => {
    withCover(publicRow(extra));
    expect((await getPublicComic(COMIC, publicBrowsingLevelsFlag, NOW))?.coverImage).toBeNull();
  });

  describe('on a post of a held model', () => {
    const POST = 990000500;
    // Post POST is on version 10, of model 1, whose gallery is held at PG when minor.
    const holdModel = (minor: boolean) => {
      installFakeCacheRedis();
      dbMock.dbRead.post.findMany.mockResolvedValue([{ id: POST, modelVersionId: 10 }] as never);
      dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: 10, modelId: 1 }] as never);
      for (const db of [dbMock.dbRead, dbMock.dbWrite])
        db.model.findFirst.mockResolvedValue({
          id: 1,
          userId: 9,
          minor,
          sfwOnly: false,
          gallerySettings: { level: NsfwLevel.PG },
        } as never);
      withCover(publicRow({ postId: POST, nsfwLevel: NsfwLevel.R }));
    };

    it('drops a cover above the held level, even at every browsing level', async () => {
      holdModel(true);
      expect((await getPublicComic(COMIC, allBrowsingLevelsFlag, NOW))?.coverImage).toBeNull();
    });

    it('serves the same cover when the model is not held', async () => {
      holdModel(false);
      expect((await getPublicComic(COMIC, allBrowsingLevelsFlag, NOW))?.coverImage?.id).toBe(COVER);
    });
  });

  it('drops a cover the shared cover filter left out', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);
    serve(
      comic({
        coverImage: { id: COVER, url: 'u', nsfwLevel: 1, modelRestricted: false, userId: OWNER },
      })
    );
    expect((await getPublicComic(COMIC, publicBrowsingLevelsFlag, NOW))?.coverImage).toBeNull();
  });

  it('asks only for images that pass the shared cover filter', async () => {
    withCover(publicRow());
    await getPublicComic(COMIC, publicBrowsingLevelsFlag, NOW);
    const { where } = dbMock.dbRead.image.findMany.mock.calls[0][0];
    expect(where.AND[0]).toEqual({ id: { in: [COVER] } });
    expect(where.AND[1].AND).toEqual(
      expect.arrayContaining([
        { needsReview: null },
        { tosViolation: false },
        { acceptableMinor: false },
        minorContentNotRestrictedWhere(),
      ])
    );
  });
});

describe('pages', () => {
  it('withholds a restricted panel image and keeps the page in order', async () => {
    serve(
      comic({
        nsfwLevel: NsfwLevel.R,
        chapters: [
          chapter(0, NsfwLevel.R, {
            panels: [
              panel(990000301, NsfwLevel.R),
              panel(990000302, NsfwLevel.R, { modelRestricted: true }),
            ],
          }),
        ],
      })
    );
    const result = await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW);
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(result.chapter.pages.map((p) => [p.number, p.url != null])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('withholds an unrated page image even at every level', async () => {
    serve(comic({ chapters: [chapter(0, NsfwLevel.PG, { panels: [panel(990000301, 0)] })] }));
    const result = await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW);
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(result.chapter.pages[0].url).toBeNull();
  });

  it('serves a resized page, not the original', async () => {
    serve(comic());
    const result = await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW);
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(result.chapter.pages[0].url).toMatch(/width=1600/);
    expect(result.chapter.pages[0].url).not.toMatch(/original=true/);
  });
});

describe('early access', () => {
  const ea = (endsAt: Date) =>
    comic({
      chapters: [
        chapter(0, NsfwLevel.PG, {
          availability: Availability.EarlyAccess,
          earlyAccessEndsAt: endsAt,
          earlyAccessConfig: { buzzPrice: 100, timeframe: 7 },
        }),
      ],
    });

  it('lists the chapter with its end date but refuses its pages until then', async () => {
    serve(ea(FUTURE));
    const listed = await getPublicComic(COMIC, allBrowsingLevelsFlag, NOW);
    expect(listed?.chapters[0]).toMatchObject({ number: 1, earlyAccessEndsAt: FUTURE });
    expect(await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW)).toEqual({
      status: 403,
      earlyAccessEndsAt: FUTURE,
    });
  });

  it('refuses rather than serving no pages when the reader locked it a moment before', async () => {
    serve(ea(FUTURE));
    const justAfter = new Date(FUTURE.getTime() + 1);
    expect((await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, justAfter)).status).toBe(
      403
    );
  });

  it('serves the pages once early access has ended', async () => {
    serve(ea(PAST));
    const result = await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW);
    expect(result.status).toBe(200);
  });
});

describe('allowDownload', () => {
  it.each([
    [{ allowDownload: true }, true],
    [{ allowDownload: false }, false],
    [{}, false],
  ])('meta %j is served as %s, and the pages are served either way', async (meta, expected) => {
    serve(comic({ meta }));
    expect((await getPublicComic(COMIC, allBrowsingLevelsFlag, NOW))?.allowDownload).toBe(expected);
    const result = await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW);
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(result.chapter.allowDownload).toBe(expected);
    expect(result.chapter.pages[0].url).not.toBeNull();
  });

  it('is on each item of the list', async () => {
    dbMock.dbRead.comicProject.findMany.mockImplementation(async ({ select }) =>
      select && 'meta' in select && !('chapters' in select)
        ? [{ id: COMIC, meta: { allowDownload: true } }]
        : [{ ...comic(), chapters: [], updatedAt: NOW, coverImage: null }]
    );
    const { items } = await listPublicComics({
      limit: 20,
      sort: 'Newest',
      browsingLevel: publicBrowsingLevelsFlag,
    });
    expect(items.map((i) => [i.id, i.allowDownload])).toEqual([[COMIC, true]]);
  });
});

describe('list items', () => {
  it('maps the feed item and hands back its cursor as a string', async () => {
    const rows = [990000102, 990000101, 990000100].map((id) => ({
      ...comic({ id }),
      chapters: [],
      updatedAt: NOW,
    }));
    dbMock.dbRead.comicProject.findMany.mockImplementation(async ({ select }) =>
      select && 'meta' in select && !('chapters' in select) ? [] : rows
    );
    const { items, nextCursor } = await listPublicComics({
      limit: 2,
      sort: 'Newest',
      browsingLevel: publicBrowsingLevelsFlag,
    });
    expect(items[0]).toMatchObject({
      id: 990000102,
      name: 'My Comic',
      url: expect.stringMatching(/\/comics\/990000102\/my-comic$/),
      user: { username: 'creator' },
      chapterCount: 0,
      allowDownload: false,
    });
    expect(nextCursor).toBe('990000101');
    expect(parseComicsCursor(nextCursor!, 'Newest')).toBe(990000101);
  });

  it('hands back a ranked cursor the next request accepts', async () => {
    const rows = [990000102, 990000101, 990000100].map((id) => ({
      ...comic({ id }),
      chapters: [],
      updatedAt: NOW,
    }));
    dbMock.dbRead.$queryRaw
      .mockReset()
      .mockImplementation((async (q: unknown) =>
        Array.isArray(q)
          ? []
          : rows.map((r, i) => ({ id: r.id, rank_value: BigInt(9 - i) }))) as never);
    dbMock.dbRead.comicProject.findMany.mockImplementation(async ({ select }) =>
      select && 'meta' in select && !('chapters' in select) ? [] : rows
    );
    const { nextCursor } = await listPublicComics({
      limit: 2,
      sort: 'MostFollowed',
      browsingLevel: publicBrowsingLevelsFlag,
    });
    expect(nextCursor).toBe('8:990000101');
    expect(parseComicsCursor(nextCursor!, 'MostFollowed')).toBe('8:990000101');
  });
});

describe('list', () => {
  it('asks the feed for public comics only, at the caller level, as a signed-out visitor', async () => {
    await listPublicComics({ limit: 20, sort: 'Newest', browsingLevel: publicBrowsingLevelsFlag });
    const { where } = dbMock.dbRead.comicProject.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ tosViolation: false, user: { bannedAt: null } });
    expect(where.nsfwLevel.in).not.toContain(NsfwLevel.R);
  });

  it('is empty for a username nobody has', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(null);
    expect(
      await listPublicComics({
        limit: 20,
        sort: 'Newest',
        username: 'nobody',
        browsingLevel: publicBrowsingLevelsFlag,
      })
    ).toEqual({ items: [], nextCursor: undefined });
    expect(dbMock.dbRead.comicProject.findMany).not.toHaveBeenCalled();
  });
});

describe('parseComicsCursor', () => {
  it.each([
    ['123', 'Newest', 123],
    ['5:123', 'MostFollowed', '5:123'],
    ['abc', 'Newest', null],
    ['99999999999', 'Newest', null],
    ['0', 'Newest', null],
    ['123', 'MostFollowed', null],
    ['x:1', 'MostChapters', null],
    ['5:99999999999', 'MostFollowed', null],
  ] as const)('%s for %s is %s', (cursor, sort, expected) => {
    expect(parseComicsCursor(cursor, sort)).toBe(expected);
  });
});

describe('comicsBrowsingLevel', () => {
  function level(country: string, nsfw?: boolean) {
    const headers: Record<string, string> = {};
    const req = { headers: { 'cf-ipcountry': country } } as unknown as NextApiRequest;
    const res = {
      setHeader: (name: string, value: string) => (headers[name] = value),
    } as unknown as NextApiResponse;
    return { browsingLevel: comicsBrowsingLevel(req, res, nsfw), headers };
  }

  it('is PG by default in every region, so the shared cache may keep it', () => {
    for (const country of ['US', 'GB']) {
      expect(level(country)).toEqual({ browsingLevel: publicBrowsingLevelsFlag, headers: {} });
    }
  });

  it('with nsfw, is every level, or SFW in a restricted region, and never shared-cached', () => {
    const cache = { 'Cache-Control': 'private, no-store' };
    expect(level('US', true)).toEqual({ browsingLevel: allBrowsingLevelsFlag, headers: cache });
    expect(level('GB', true)).toEqual({ browsingLevel: sfwBrowsingLevelsFlag, headers: cache });
  });
});
