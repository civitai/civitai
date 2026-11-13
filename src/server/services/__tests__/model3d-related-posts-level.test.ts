import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { relatedPostsBrowsingLevel } from '~/server/utils/browsing-level';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const h = vi.hoisted(() => ({
  // Each viewer's own hidden tags, by user id (-1: signed out).
  hiddenByUser: {} as Record<number, { id: number; hidden: boolean }[]>,
  addons: [] as unknown[],
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAllHiddenForUser: async ({ userId = -1 }: { userId?: number }) => ({
    hiddenTags: h.hiddenByUser[userId] ?? [],
  }),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBrowsingSettingAddons: async () => h.addons,
  getBlockedBrowsingTags: async () => [],
}));

const { getModel3DRelatedPosts } = await import('~/server/services/model3d.service');

/**
 * The "Makes & Uses" rail lists other people's posts, so it is held to the viewer's level as the
 * post feed is. The fake applies the query's own `where`, order, cursor and `take` to rows in
 * memory, and refuses any operator it does not know: what a test sees listed is what the query
 * would select.
 */
type Row = Record<string, unknown>;
const OPERATORS = new Set(['in', 'not', 'lte', 'some', 'none']);
const matches = (row: Row, where: Row | undefined): boolean =>
  !where ||
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (!(key in row)) throw new Error(`The fake has no column ${key}`);
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const ops = cond as { in?: unknown[]; not?: unknown; lte?: Date; some?: Row; none?: Row };
      for (const op of Object.keys(ops))
        if (!OPERATORS.has(op)) throw new Error(`The fake does not know ${op}`);
      if ('in' in ops && !ops.in!.includes(value)) return false;
      if ('not' in ops && value === ops.not) return false;
      if ('lte' in ops && !(value instanceof Date && value <= ops.lte!)) return false;
      if ('some' in ops && !(value as Row[]).some((r) => matches(r, ops.some))) return false;
      if ('none' in ops && (value as Row[]).some((r) => matches(r, ops.none))) return false;
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
  tags: [] as Row[],
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
  // A post level that has drifted from its images: rated XXX, its one image PG.
  post(17, XXX, [image(PG)]),
  // Another user's unrated draft: its image not yet rated.
  post(18, 0, [image(0, { userId: STRANGER, ingestion: 'Pending' })], {
    userId: STRANGER,
    publishedAt: null,
  }),
  // Their PG draft whose first image is not yet rated.
  post(
    19,
    PG,
    [image(0, { userId: STRANGER, ingestion: 'Pending' }), image(PG, { userId: STRANGER })],
    {
      userId: STRANGER,
      publishedAt: null,
    }
  ),
];
const RESTRICTED_MATURE = new Set([9001]);
let rows: Row[] = POSTS;

type Args = {
  where: Row;
  take: number;
  cursor?: { id: number };
  select: { images: { where?: Row; take: number; select: Row } };
};
beforeEach(() => {
  rows = POSTS;
  h.hiddenByUser = {};
  h.addons = [];
  dbMock.dbRead.model3D.findUnique.mockResolvedValue({
    id: MODEL3D,
    userId: OWNER,
    status: 'Published',
    deletedAt: null,
    tosViolation: false,
  } as never);
  // The restricted-model lookup, over the cover candidates it is asked about.
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) =>
    Prisma.sql(strings, ...(values as never[]))
      .values.filter((v): v is number => typeof v === 'number' && RESTRICTED_MATURE.has(v))
      .map((id) => ({ id }))) as never);
  dbMock.dbRead.post.findMany.mockImplementation((async (args: Args) => {
    const ordered = (rows as typeof POSTS)
      .filter((p) => matches(p, args.where))
      .sort(
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
        .slice(0, args.select.images.take)
        // Only the fields the query selects are in the row it returns.
        .map((i) =>
          Object.fromEntries(Object.entries(i).filter(([k]) => args.select.images.select[k]))
        ),
    }));
  }) as never);
});

const page = (
  user: { id: number; isModerator?: boolean } | undefined,
  level?: number,
  extra: { limit?: number; cursor?: number; servesUnrated?: boolean } = {}
) =>
  getModel3DRelatedPosts({
    input: { model3dId: MODEL3D, limit: extra.limit ?? 12, cursor: extra.cursor },
    user: user as never,
    browsingLevel: level,
    servesUnrated: extra.servesUnrated,
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

  it("goes by the post's own level, even where a PG cover would pass", async () => {
    expect((await listed(undefined, publicBrowsingLevelsFlag)).some((p) => p.id === 17)).toBe(
      false
    );
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
      { id: 17, cover: PG },
      { id: 15, cover: R },
      { id: 13, cover: PG },
      { id: 12, cover: XXX },
      { id: 11, cover: X },
      { id: 4, cover: R },
      { id: 2, cover: XXX },
      { id: 1, cover: PG },
    ]);
  });

  it('shows a viewer their own draft within their level, and not to anyone else', async () => {
    const own = async (level: number, servesUnrated = false) =>
      (await listed({ id: STRANGER }, level, { limit: 50, servesUnrated })).filter((p) =>
        [5, 18].includes(p.id)
      );
    expect(await own(PG | R)).toEqual([{ id: 5, cover: R }]);
    // Their R draft is above a PG level, own or not.
    expect(await own(PG)).toEqual([]);
    // Unrated, only where the domain serves unrated content.
    expect(await own(PG, true)).toEqual([{ id: 18, cover: 0 }]);
    // An unrated image is passed over for a rated cover where the domain doesn't serve unrated.
    const draft = async (servesUnrated: boolean) =>
      (await listed({ id: STRANGER }, PG, { limit: 50, servesUnrated })).find((p) => p.id === 19);
    expect(await draft(false)).toEqual({ id: 19, cover: PG });
    expect(await draft(true)).toEqual({ id: 19, cover: 0 });
    expect(
      (await listed({ id: 77 }, allBrowsingLevelsFlag, { limit: 50, servesUnrated: true })).some(
        (p) => [5, 18, 19].includes(p.id)
      )
    ).toBe(false);
  });

  it('pages through what the viewer may see', async () => {
    const a = await page(undefined, publicBrowsingLevelsFlag, { limit: 2 });
    expect(a.items.map((p) => p.id)).toEqual([13, 4]);
    const b = await page(undefined, publicBrowsingLevelsFlag, { limit: 2, cursor: a.nextCursor });
    expect(b.items.map((p) => p.id)).toEqual([1]);
    expect(b.nextCursor).toBeUndefined();
  });

  it("never returns a cover's generation data, to anyone", async () => {
    for (const user of [undefined, { id: STRANGER }, { id: OWNER }, { id: 1, isModerator: true }]) {
      const cover = (await page(user, publicBrowsingLevelsFlag, { limit: 50 })).items.find(
        (p) => p.id === 1
      )?.images[0];
      expect(cover?.id).toBeDefined();
      expect(cover).not.toHaveProperty('meta');
    }
  });

  it('shows a moderator posts in any state, but only within their level', async () => {
    const mod = { id: 1, isModerator: true };
    const atPG = await listed(mod, publicBrowsingLevelsFlag, { limit: 50 });
    // A draft and posts whose only image is in review or flagged: a moderator still sees them.
    expect(atPG.find((p) => p.id === 8)).toEqual({ id: 8, cover: PG });
    expect(atPG.find((p) => p.id === 7)).toEqual({ id: 7, cover: PG });
    // Nothing above PG: no XXX post, no XXX cover, and no unrated post on a SFW-only domain.
    expect(atPG.some((p) => [2, 11, 17, 3, 18].includes(p.id))).toBe(false);
    expect(atPG.every((p) => p.cover === null || p.cover === PG)).toBe(true);
    expect(atPG.find((p) => p.id === 12)).toEqual({ id: 12, cover: null });
    // Unrated, where the domain serves it.
    const unrated = await listed(mod, publicBrowsingLevelsFlag, { limit: 50, servesUnrated: true });
    expect(unrated.find((p) => p.id === 18)).toEqual({ id: 18, cover: 0 });
    // At every level they see every post that has one (control).
    const all = await listed(mod, allBrowsingLevelsFlag, { limit: 50, servesUnrated: true });
    expect(all.find((p) => p.id === 2)).toEqual({ id: 2, cover: XXX });
  });

  it('answers for a draft, deleted or ToS-flagged 3D model only to its owner and moderators', async () => {
    for (const state of [{ status: 'Draft' }, { deletedAt: past }, { tosViolation: true }]) {
      dbMock.dbRead.model3D.findUnique.mockResolvedValue({
        id: MODEL3D,
        userId: OWNER,
        status: 'Published',
        deletedAt: null,
        tosViolation: false,
        ...state,
      } as never);
      await expect(page(undefined, publicBrowsingLevelsFlag)).rejects.toThrow(/No 3D model/);
      await expect(page({ id: STRANGER }, publicBrowsingLevelsFlag)).rejects.toThrow(/No 3D model/);
      expect((await page({ id: OWNER }, publicBrowsingLevelsFlag)).items).toBeInstanceOf(Array);
      expect(
        (await page({ id: 1, isModerator: true }, publicBrowsingLevelsFlag)).items
      ).toBeInstanceOf(Array);
    }
  });
});

describe('getModel3DRelatedPosts, with hidden tags', () => {
  const HIDDEN = 100;
  const SITE_HIDDEN = 200;
  const tagged = (tagId: number, disabled = false) => [{ tagId, disabled }];
  const TAG_POSTS = [
    // Its first image carries a hidden tag: the next one is its cover.
    post(30, PG, [image(PG, { tags: tagged(HIDDEN) }), image(PG)]),
    // Its only image carries a hidden tag: not listed.
    post(31, PG, [image(PG, { tags: tagged(HIDDEN) })]),
    // A tag vote that was disabled hides nothing.
    post(32, PG, [image(PG, { tags: tagged(HIDDEN, true) })]),
    // Another user's post whose only image carries a tag the site hides at PG.
    post(33, PG, [image(PG, { userId: STRANGER, tags: tagged(SITE_HIDDEN) })], {
      userId: STRANGER,
    }),
  ];
  const coverOf = async (user: Parameters<typeof page>[0]) =>
    Object.fromEntries(
      (await page(user, publicBrowsingLevelsFlag, { limit: 50 })).items.map((p) => [
        p.id,
        p.images[0]?.id ?? null,
      ])
    );
  const [first30, second30] = TAG_POSTS[0].images.map((i) => i.id);
  beforeEach(() => {
    rows = TAG_POSTS;
  });

  it('lists every post and its first cover when nothing is hidden (control)', async () => {
    expect(await coverOf({ id: 77 })).toEqual({
      30: first30,
      31: TAG_POSTS[1].images[0].id,
      32: TAG_POSTS[2].images[0].id,
      33: TAG_POSTS[3].images[0].id,
    });
  });

  it('passes over a cover carrying a tag the viewer hid, moderators included', async () => {
    h.hiddenByUser = { 77: [{ id: HIDDEN, hidden: true }], 1: [{ id: HIDDEN, hidden: true }] };
    // Another viewer's hides are not this viewer's (control).
    expect((await coverOf({ id: STRANGER }))[30]).toBe(first30);
    for (const user of [{ id: 77 }, { id: 1, isModerator: true }]) {
      const covers = await coverOf(user);
      expect(covers[30]).toBe(second30);
      expect(covers[32]).toBe(TAG_POSTS[2].images[0].id);
    }
    expect(await coverOf({ id: 77 })).not.toHaveProperty('31');
    // A moderator sees posts in any state: listed, with no cover.
    expect((await coverOf({ id: 1, isModerator: true }))[31]).toBeNull();
    // A tag the viewer only voted on, not hid, hides nothing.
    h.hiddenByUser = { 77: [{ id: HIDDEN, hidden: false }] };
    expect((await coverOf({ id: 77 }))[30]).toBe(first30);
  });

  it('an R+ post whose only passing cover carries a child tag is not listed for an R viewer', async () => {
    const CHILD = 300;
    rows = [
      post(40, R, [image(R, { userId: STRANGER, tags: tagged(CHILD) })], { userId: STRANGER }),
      // Control: the same post without the tag is listed.
      post(41, R, [image(R, { userId: STRANGER })], { userId: STRANGER }),
    ];
    h.addons = [{ type: 'some', nsfwLevels: [R, X, XXX], excludedTagIds: [CHILD] }];
    const ids = (await page({ id: 77 }, R, { limit: 50 })).items.map((p) => p.id);
    expect(ids).toEqual([41]);
  });

  it("keeps covers with a tag the viewer hid when they turned hiding off; the site's tags still apply", async () => {
    h.hiddenByUser = { 77: [{ id: HIDDEN, hidden: true }] };
    h.addons = [{ type: 'some', nsfwLevels: [PG], excludedTagIds: [SITE_HIDDEN] }];
    const { items } = await getModel3DRelatedPosts({
      input: { model3dId: MODEL3D, limit: 50 },
      user: { id: 77 } as never,
      browsingLevel: publicBrowsingLevelsFlag,
      disableHidden: true,
    });
    const covers = Object.fromEntries(items.map((p) => [p.id, p.images[0]?.id ?? null]));
    expect(covers[30]).toBe(first30);
    expect(covers).toHaveProperty('31');
    expect(covers).not.toHaveProperty('33');
  });

  it("hides a site-hidden tag at the viewer's level, except on the viewer's own image", async () => {
    h.addons = [{ type: 'some', nsfwLevels: [PG], excludedTagIds: [SITE_HIDDEN] }];
    expect(await coverOf(undefined)).not.toHaveProperty('33');
    expect(await coverOf({ id: 77 })).not.toHaveProperty('33');
    expect((await coverOf({ id: STRANGER }))[33]).toBe(TAG_POSTS[3].images[0].id);
    // A moderator is not held to the site's hidden tags.
    expect((await coverOf({ id: 1, isModerator: true }))[33]).toBe(TAG_POSTS[3].images[0].id);
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

  it('holds a verified crawler with nothing asked to PG where mature content is allowed', () => {
    const crawler = {
      user: undefined,
      features: { canViewNsfw: true, isGreen: false },
      req: { headers: { [VERIFIED_BOT_HEADER]: 'googlebot' } },
    } as never;
    expect(relatedPostsBrowsingLevel(crawler, undefined)).toBe(publicBrowsingLevelsFlag);
  });

  it("reads a signed-in mature viewer's saved level when none is asked, and what they ask for otherwise", () => {
    expect(relatedPostsBrowsingLevel(mature(PG | R), undefined)).toBe(PG | R);
    expect(relatedPostsBrowsingLevel(mature(PG | R), XXX)).toBe(XXX);
  });
});
