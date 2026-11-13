import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { relatedPostsBrowsingLevel } from '~/server/utils/browsing-level';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const { getModel3DRelatedPosts } = await import('~/server/services/model3d.service');

/**
 * The "Makes & Uses" rail lists other people's posts, so it is held to the viewer's level as the
 * post feed is. The fake applies the query's own `where`, order, cursor and `take` to rows in
 * memory, and refuses any operator it does not know: what a test sees listed is what the query
 * would select.
 */
type Row = Record<string, unknown>;
const OPERATORS = new Set(['in', 'not', 'lte', 'some']);
const matches = (row: Row, where: Row | undefined): boolean =>
  !where ||
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (!(key in row)) throw new Error(`The fake has no column ${key}`);
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const ops = cond as { in?: unknown[]; not?: unknown; lte?: Date; some?: Row };
      for (const op of Object.keys(ops))
        if (!OPERATORS.has(op)) throw new Error(`The fake does not know ${op}`);
      if ('in' in ops && !ops.in!.includes(value)) return false;
      if ('not' in ops && value === ops.not) return false;
      if ('lte' in ops && !(value instanceof Date && value <= ops.lte!)) return false;
      if ('some' in ops && !(value as Row[]).some((r) => matches(r, ops.some))) return false;
      return true;
    }
    return value === cond;
  });

const MODEL3D = 9;
const OWNER = 5;
const STRANGER = 6;
const past = new Date('2026-01-01T00:00:00Z');
let nextImageId = 1;
const image = (nsfwLevel: number, over: Row = {}) => ({
  id: nextImageId++,
  userId: OWNER,
  index: 0,
  nsfwLevel,
  ingestion: 'Scanned',
  needsReview: null,
  blockedFor: null,
  acceptableMinor: false,
  poi: false,
  minor: false,
  ...over,
});
const post = (id: number, nsfwLevel: number, images: Row[], over: Row = {}) => ({
  id,
  model3dId: MODEL3D,
  userId: OWNER,
  // Newer ids published later, so the query's order (newest first) is by id.
  publishedAt: new Date(past.getTime() + id * 1000),
  availability: 'Public',
  nsfwLevel,
  images,
  ...over,
});
const { PG, R, X, XXX, Blocked } = NsfwLevel;
const POSTS = [
  post(1, PG, [image(PG, { hideMeta: true, meta: { prompt: 'hidden' } })]),
  post(2, XXX, [image(XXX)]),
  post(3, 0, [image(PG, { ingestion: 'Pending' })]),
  post(4, PG | R, [image(R), image(PG)]),
  // Another user's draft, its image not yet scanned.
  post(5, R, [image(R, { userId: STRANGER, ingestion: 'Pending' })], {
    userId: STRANGER,
    publishedAt: null,
  }),
  // Rated PG, but each image is one the feed would not show: the post is not listed.
  post(6, PG, [image(PG, { ingestion: 'Pending' })]),
  post(7, PG, [image(PG, { needsReview: 'csam' })]),
  post(8, PG, [image(PG, { poi: true })]),
  post(9, PG, [image(PG, { minor: true })]),
  post(10, PG, [image(PG, { acceptableMinor: true })]),
  // Combined levels: X|XXX shares nothing with R; PG|XXX shares XXX; PG|Blocked shares PG.
  post(11, X | XXX, [image(X)]),
  post(12, PG | XXX, [image(XXX)]),
  post(13, PG | Blocked, [image(PG), image(Blocked)]),
  post(14, PG, [image(PG, { blockedFor: 'tos' })]),
  // A restricted model's mature image is passed over for the next one.
  post(15, R, [image(R, { id: 9001 }), image(R)]),
  // Blocked alone is no level a viewer browses at.
  post(16, Blocked, [image(Blocked)]),
];
const RESTRICTED_MATURE = new Set([9001]);

type Args = {
  where: Row;
  take: number;
  cursor?: { id: number };
  select: { images: { where?: Row; take: number } };
};
beforeEach(() => {
  dbMock.dbRead.model3D.findUnique.mockResolvedValue({ id: MODEL3D, userId: OWNER } as never);
  // The restricted-model lookup, over the cover candidates it is asked about.
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) =>
    Prisma.sql(strings, ...(values as never[]))
      .values.filter((v): v is number => typeof v === 'number' && RESTRICTED_MATURE.has(v))
      .map((id) => ({ id }))) as never);
  dbMock.dbRead.post.findMany.mockImplementation((async (args: Args) => {
    const ordered = POSTS.filter((p) => matches(p, args.where)).sort(
      (a, b) =>
        Number(!a.publishedAt) - Number(!b.publishedAt) ||
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) ||
        b.id - a.id
    );
    const from = args.cursor ? ordered.findIndex((p) => p.id === args.cursor!.id) : 0;
    return ordered.slice(from, from + args.take).map((p) => ({
      ...p,
      images: (p.images as Row[])
        .filter((i) => matches(i, args.select.images.where))
        .slice(0, args.select.images.take),
    }));
  }) as never);
});

const page = (
  user: { id: number; isModerator?: boolean } | undefined,
  level?: number,
  extra: { limit?: number; cursor?: number } = {}
) =>
  getModel3DRelatedPosts({
    input: { model3dId: MODEL3D, limit: extra.limit ?? 12, cursor: extra.cursor },
    user: user as never,
    browsingLevel: level,
  });
const listed = async (...args: Parameters<typeof page>) =>
  (await page(...args)).items.map((p) => ({ id: p.id, cover: p.images[0]?.nsfwLevel ?? null }));

describe('getModel3DRelatedPosts', () => {
  it('lists a PG viewer only posts sharing PG, with a cover the feed would show, and no unrated post', async () => {
    expect(await listed(undefined, publicBrowsingLevelsFlag)).toEqual([
      { id: 13, cover: PG },
      // Its R image is passed over for the PG one.
      { id: 4, cover: PG },
      { id: 1, cover: PG },
    ]);
  });

  it('reads PG only when no level is given', async () => {
    expect((await listed(undefined)).map((p) => p.id)).toEqual([13, 4, 1]);
  });

  it("gives a signed-in PG viewer another user's post with a PG cover, not its R image", async () => {
    expect((await listed({ id: 77 }, publicBrowsingLevelsFlag)).find((p) => p.id === 4)).toEqual({
      id: 4,
      cover: PG,
    });
  });

  it('lists an R viewer nothing that shares only X or XXX', async () => {
    expect((await listed({ id: 77 }, R)).map((p) => p.id)).toEqual([15, 4]);
    // Post 15's first image is a restricted model's mature one: the next is its cover.
    const { items } = await page({ id: 77 }, R);
    expect(items.find((p) => p.id === 15)?.images.map((i) => i.id)).not.toContain(9001);
    expect(items.find((p) => p.id === 15)?.images).toHaveLength(1);
  });

  it("lists a mature viewer's level, still without the unrated post", async () => {
    expect(await listed({ id: 77 }, allBrowsingLevelsFlag | Blocked, { limit: 50 })).toEqual([
      { id: 15, cover: R },
      { id: 13, cover: PG },
      { id: 12, cover: XXX },
      { id: 11, cover: X },
      { id: 4, cover: R },
      { id: 2, cover: XXX },
      { id: 1, cover: PG },
    ]);
  });

  it('shows a viewer their own draft with their own cover, and not to anyone else', async () => {
    const own = await listed({ id: STRANGER }, publicBrowsingLevelsFlag);
    expect(own.find((p) => p.id === 5)).toEqual({ id: 5, cover: R });
    expect(
      (await listed({ id: 77 }, allBrowsingLevelsFlag, { limit: 50 })).some((p) => p.id === 5)
    ).toBe(false);
  });

  it('pages through what the viewer may see', async () => {
    const a = await page(undefined, publicBrowsingLevelsFlag, { limit: 2 });
    expect(a.items.map((p) => p.id)).toEqual([13, 4]);
    const b = await page(undefined, publicBrowsingLevelsFlag, { limit: 2, cursor: a.nextCursor });
    expect(b.items.map((p) => p.id)).toEqual([1]);
    expect(b.nextCursor).toBeUndefined();
  });

  it("withholds a cover's hidden prompt from everyone but its owner and moderators", async () => {
    const meta = async (user: Parameters<typeof page>[0]) =>
      (await page(user, publicBrowsingLevelsFlag, { limit: 50 })).items.find((p) => p.id === 1)
        ?.images[0]?.meta;
    expect(await meta(undefined)).toBeNull();
    expect(await meta({ id: STRANGER })).toBeNull();
    expect(await meta({ id: OWNER })).toEqual({ prompt: 'hidden' });
    expect(await meta({ id: 1, isModerator: true })).toEqual({ prompt: 'hidden' });
  });

  it('shows a moderator every post with its first image (control)', async () => {
    const all = await listed({ id: 1, isModerator: true }, publicBrowsingLevelsFlag, { limit: 50 });
    expect(all).toHaveLength(POSTS.length);
    expect(all.find((p) => p.id === 2)).toEqual({ id: 2, cover: XXX });
    expect(all.find((p) => p.id === 8)).toEqual({ id: 8, cover: PG });
  });
});

describe('relatedPostsBrowsingLevel', () => {
  const ctx = (over: { user?: Row; canViewNsfw: boolean; isGreen: boolean }) =>
    ({
      user: over.user,
      features: { canViewNsfw: over.canViewNsfw, isGreen: over.isGreen },
      req: { headers: {} },
    } as never);
  const mature = (saved: number) =>
    ctx({
      user: { id: 1, showNsfw: true, browsingLevel: saved },
      canViewNsfw: true,
      isGreen: false,
    });

  it('holds a signed-out viewer to PG whatever is asked', () => {
    expect(
      relatedPostsBrowsingLevel(ctx({ canViewNsfw: true, isGreen: false }), allBrowsingLevelsFlag)
    ).toBe(publicBrowsingLevelsFlag);
  });

  it('holds a signed-in viewer on the SFW domain to PG and PG-13', () => {
    expect(
      relatedPostsBrowsingLevel(
        ctx({ user: { id: 1 }, canViewNsfw: false, isGreen: true }),
        allBrowsingLevelsFlag
      )
    ).toBe(sfwBrowsingLevelsFlag);
  });

  it("reads a signed-in mature viewer's saved level when none is asked, and what they ask for otherwise", () => {
    expect(relatedPostsBrowsingLevel(mature(PG | R), undefined)).toBe(PG | R);
    expect(relatedPostsBrowsingLevel(mature(PG | R), XXX)).toBe(XXX);
  });
});
