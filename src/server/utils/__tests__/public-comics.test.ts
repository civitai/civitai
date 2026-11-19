import { beforeEach, describe, expect, it, vi } from 'vitest';

// A region restricted since 2020, read when region-blocking loads.
vi.hoisted(() => {
  process.env.REGION_RESTRICTION_CONFIG = 'GB:2020-01-01';
});

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  comicsBrowsingLevel,
  getPublicComic,
  getPublicComicChapter,
  listPublicComics,
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

/**
 * The comics REST API serves what the site's public reader serves to a signed-out visitor,
 * narrowed to the caller's browsing level. These drive the real reader service over database rows.
 */

const OWNER = 990000001;
const COMIC = 990000100;
const NOW = new Date('2026-11-19T00:00:00Z');

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
    const endsAt = new Date('2026-11-25T00:00:00Z');
    serve(ea(endsAt));
    const listed = await getPublicComic(COMIC, allBrowsingLevelsFlag, NOW);
    expect(listed?.chapters[0]).toMatchObject({ number: 1, earlyAccessEndsAt: endsAt });
    expect(await getPublicComicChapter(COMIC, 1, allBrowsingLevelsFlag, NOW)).toEqual({
      status: 403,
      earlyAccessEndsAt: endsAt,
    });
  });

  it('serves the pages once early access has ended', async () => {
    serve(ea(new Date('2026-11-10T00:00:00Z')));
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

describe('list', () => {
  it('asks the feed for public comics only, at the caller level, as a signed-out visitor', async () => {
    await listPublicComics({ limit: 20, sort: 'Newest', browsingLevel: publicBrowsingLevelsFlag });
    const { where } = dbMock.dbRead.comicProject.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ tosViolation: false, user: { bannedAt: null } });
    // Mature levels are never in the allowed set at the public level.
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
