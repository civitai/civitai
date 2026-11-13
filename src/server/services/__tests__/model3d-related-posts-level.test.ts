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
 * post feed is. The fake applies the query's own `where` to rows in memory: what a test sees
 * listed is what the query would select.
 */
type Row = Record<string, unknown>;
const matches = (row: Row, where: Record<string, unknown> | undefined): boolean =>
  !where ||
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown; lte?: Date };
      if (c.in && !c.in.includes(value)) return false;
      if ('not' in c && value === c.not) return false;
      if (c.lte && !(value instanceof Date && value <= c.lte)) return false;
      return true;
    }
    return value === cond;
  });

const MODEL3D = 9;
const OWNER = 5;
const STRANGER = 6;
const past = new Date('2026-01-01T00:00:00Z');
const image = (nsfwLevel: number, over: Row = {}) => ({
  id: nsfwLevel * 100,
  userId: OWNER,
  index: 0,
  nsfwLevel,
  ingestion: 'Scanned',
  needsReview: null,
  acceptableMinor: false,
  poi: false,
  minor: false,
  ...over,
});
const post = (id: number, nsfwLevel: number, images: Row[], over: Row = {}) => ({
  id,
  model3dId: MODEL3D,
  userId: OWNER,
  publishedAt: past,
  availability: 'Public',
  nsfwLevel,
  images,
  ...over,
});
const POSTS = [
  post(1, NsfwLevel.PG, [image(NsfwLevel.PG)]),
  post(2, NsfwLevel.XXX, [image(NsfwLevel.XXX)]),
  post(3, 0, [image(NsfwLevel.PG, { ingestion: 'Pending' })]),
  post(4, NsfwLevel.PG | NsfwLevel.R, [image(NsfwLevel.R), image(NsfwLevel.PG)]),
  post(5, NsfwLevel.R, [image(NsfwLevel.R)], { userId: STRANGER, publishedAt: null }),
];

beforeEach(() => {
  dbMock.dbRead.model3D.findUnique.mockResolvedValue({ id: MODEL3D, userId: OWNER } as never);
  dbMock.dbRead.post.findMany.mockImplementation((async (args: {
    where: Row;
    take: number;
    include?: never;
    select: { images: { where?: Row } };
  }) =>
    POSTS.filter((p) => matches(p, args.where))
      .slice(0, args.take)
      .map((p) => ({
        ...p,
        images: (p.images as Row[]).filter((i) => matches(i, args.select.images.where)).slice(0, 1),
      }))) as never);
});

const listed = async (user: { id: number; isModerator?: boolean } | undefined, level?: number) => {
  const { items } = await getModel3DRelatedPosts({
    input: { model3dId: MODEL3D, limit: 12 },
    user: user as never,
    browsingLevel: level,
  });
  return items.map((p) => ({ id: p.id, cover: p.images[0]?.nsfwLevel ?? null }));
};

describe('getModel3DRelatedPosts', () => {
  it('lists only posts within a PG viewer’s level, with a cover within it, and no unrated post', async () => {
    expect(await listed(undefined, publicBrowsingLevelsFlag)).toEqual([
      { id: 1, cover: NsfwLevel.PG },
      // A PG|R post shares PG with the viewer, as in the post feed; its R image is not the cover.
      { id: 4, cover: NsfwLevel.PG },
    ]);
  });

  it('reads PG only when no level is given', async () => {
    expect((await listed(undefined)).map((p) => p.id)).toEqual([1, 4]);
  });

  it('lists a mature viewer’s level, still without the unrated post', async () => {
    expect((await listed({ id: 77 }, allBrowsingLevelsFlag)).map((p) => p.id)).toEqual([1, 2, 4]);
  });

  it('shows a viewer their own posts in any state', async () => {
    expect((await listed({ id: STRANGER }, publicBrowsingLevelsFlag)).map((p) => p.id)).toEqual([
      1, 4, 5,
    ]);
  });

  it('shows a moderator every post (control)', async () => {
    expect((await listed({ id: 1, isModerator: true }, publicBrowsingLevelsFlag)).length).toBe(5);
  });
});

describe('relatedPostsBrowsingLevel', () => {
  const ctx = (over: { user?: Row; canViewNsfw: boolean; isGreen: boolean }) =>
    ({
      user: over.user,
      features: { canViewNsfw: over.canViewNsfw, isGreen: over.isGreen },
      req: { headers: {} },
    } as never);

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

  it("reads a signed-in mature viewer's saved level when none is asked", () => {
    const saved = NsfwLevel.PG | NsfwLevel.R;
    expect(
      relatedPostsBrowsingLevel(
        ctx({
          user: { id: 1, showNsfw: true, browsingLevel: saved },
          canViewNsfw: true,
          isGreen: false,
        }),
        undefined
      )
    ).toBe(saved);
  });
});
