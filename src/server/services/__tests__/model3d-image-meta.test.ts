import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userContentOverviewCache: { refresh: vi.fn() },
}));

const {
  getModel3DById,
  getModel3DsInfinite,
  publishModel3D,
  restoreModel3D,
  setModel3DNsfwLevel,
  toggleModel3DFlag,
  unpublishModel3D,
  upsertModel3D,
} = await import('~/server/services/model3d.service');

type Row = Record<string, unknown>;
type Select = { [key: string]: boolean | { select: Select } | unknown };

/** What the query would return: only the fields its `select` asks for. */
const applySelect = (row: Row, select: Select): Row =>
  Object.fromEntries(
    Object.entries(select)
      .filter(([key, pick]) => pick && key in row)
      .map(([key, pick]) => {
        const value = row[key];
        const nested = (pick as { select?: Select }).select;
        return [
          key,
          nested && value && typeof value === 'object' && !Array.isArray(value)
            ? applySelect(value as Row, nested)
            : value,
        ];
      })
  );

/** Every field a 3D model's image may return: what its pages and cards draw. */
const DRAWN = [
  'id',
  'name',
  'url',
  'nsfwLevel',
  'width',
  'height',
  'hash',
  'type',
  'userId',
  'createdAt',
  'postId',
];
const image = (id: number) => ({
  id,
  name: `image-${id}`,
  url: `img-${id}`,
  nsfwLevel: 1,
  width: 512,
  height: 512,
  hash: 'hash',
  type: 'image',
  userId: 5,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  postId: null,
  hideMeta: true,
  generationProcess: 'txt2img',
  scannedAt: new Date('2026-01-01T00:00:00Z'),
  meta: { prompt: 'a prompt its owner hid' },
  needsReview: 'poi',
  ingestion: 'Blocked',
  blockedFor: 'review',
  metadata: {
    width: 512,
    height: 512,
    duration: 3,
    ruleId: 7,
    ruleReason: 'a rule',
    nsfwLevelReason: 'a reason',
  },
});
/** Generation data and moderation state, none of which a 3D model read returns. */
const HIDDEN = ['meta', 'hideMeta', 'needsReview', 'ingestion', 'blockedFor'];
const expectNoHidden = (img: unknown) => {
  for (const key of HIDDEN) expect(img).not.toHaveProperty(key);
};
/** A page or an action's result draws no image metadata at all. */
const expectNoMetadata = (img: unknown) => {
  expectNoHidden(img);
  // Exactly what the pages draw: nothing else the image row carries.
  expect(Object.keys(img as object).sort()).toEqual([...DRAWN].sort());
};
const MODEL = {
  id: 9,
  name: 'model',
  userId: 5,
  status: Model3DStatus.Published,
  deletedAt: null,
  nsfwLevel: 1,
  thumbnailImage: image(1),
  sourceImage: image(2),
  tags: [],
};

beforeEach(() => {
  // No image is a restricted model's mature one, unless a test says so.
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  // The source image is one the viewer may see.
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    nsfwLevel: 1,
    ingestion: 'Scanned',
    blockedFor: null,
    needsReview: null,
    minor: false,
    poi: false,
  } as never);
  dbMock.dbRead.model3D.findUnique.mockImplementation((async (args: { select: Select }) =>
    applySelect(MODEL, args.select)) as never);
  dbMock.dbRead.model3D.findMany.mockImplementation((async (args: { select: Select }) => [
    applySelect(MODEL, args.select),
  ]) as never);
  dbMock.dbRead.model3DReview.findUnique.mockResolvedValue(null as never);
  dbMock.dbRead.model3DReview.findMany.mockResolvedValue([] as never);

  const write = dbMock.dbWrite;
  write.model3D.findUnique.mockResolvedValue({
    ...MODEL,
    status: Model3DStatus.Unpublished,
    thumbnailImageId: 1,
    lockedProperties: [],
    tosViolation: false,
  } as never);
  write.model3D.update.mockImplementation((async (args: { select: Select }) =>
    applySelect(MODEL, args.select)) as never);
  write.model3D.create.mockImplementation((async (args: { select: Select }) =>
    applySelect(MODEL, args.select)) as never);
  write.$transaction.mockImplementation((async (cb: (tx: unknown) => unknown) =>
    cb(write)) as never);
});

describe('a 3D model page', () => {
  it("never returns its source image's or thumbnail's generation data, to anyone", async () => {
    for (const user of [null, { id: 6 }, { id: 5 }, { id: 1, isModerator: true }]) {
      const model = await getModel3DById({ id: 9, user: user as never });
      expect(model.sourceImage?.id).toBe(2);
      expect(model.thumbnailImage?.id).toBe(1);
      expectNoMetadata(model.sourceImage);
      expectNoMetadata(model.thumbnailImage);
    }
  });

  it("the feed never returns a card thumbnail's generation data", async () => {
    const { items } = await getModel3DsInfinite({ limit: 10, user: null } as never);
    expect(items[0]?.thumbnailImage?.id).toBe(1);
    expectNoHidden(items[0]?.thumbnailImage);
    // Only what the card's media player reads: never a moderation reason.
    expect(items[0]?.thumbnailImage?.metadata).toEqual({ width: 512, height: 512, duration: 3 });
  });
});

describe('a 3D model edit or moderation action', () => {
  const owner = { id: 5 } as never;
  const moderator = { id: 1, isModerator: true } as never;
  it.each([
    ['saving it', () => upsertModel3D({ input: { id: 9, name: 'model' } as never, user: owner })],
    ['creating it', () => upsertModel3D({ input: { name: 'model' } as never, user: owner })],
    ['publishing it', () => publishModel3D({ input: { id: 9 }, user: owner })],
    ['unpublishing it', () => unpublishModel3D({ input: { id: 9 }, user: owner })],
    [
      'rating it',
      () => setModel3DNsfwLevel({ id: 9, nsfwLevel: 4, thumbnailImageId: 1, user: moderator }),
    ],
    ['flagging it', () => toggleModel3DFlag({ id: 9, field: 'poi', user: moderator })],
    ['restoring it', () => restoreModel3D({ id: 9, user: moderator })],
  ])(
    "%s returns the model without its images' generation data or moderation state",
    async (_, act) => {
      const model = await act();
      expect(model.sourceImage?.id).toBe(2);
      expect(model.thumbnailImage?.id).toBe(1);
      expectNoMetadata(model.sourceImage);
      expectNoMetadata(model.thumbnailImage);
    }
  );
});

describe("a 3D model's source image", () => {
  const passing = {
    nsfwLevel: 1,
    ingestion: 'Scanned',
    blockedFor: null,
    needsReview: null,
    minor: false,
    poi: false,
  };
  const sourceFor = async (user: unknown, state: object, browsingLevel = 1) => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({ ...passing, ...state } as never);
    const model = await getModel3DById({ id: 9, user: user as never, browsingLevel });
    return model.sourceImage?.id ?? null;
  };

  it.each([
    ['above the viewer level', { nsfwLevel: 4 }],
    ['not yet scanned', { ingestion: 'Pending' }],
    ['blocked', { blockedFor: 'tos' }],
    ['in review', { needsReview: 'minor' }],
    ['flagged minor', { minor: true }],
    ['flagged poi', { poi: true }],
  ])('is not returned to another viewer when %s', async (_, state) => {
    for (const user of [null, { id: 6 }]) expect(await sourceFor(user, state)).toBeNull();
  });

  it("is not returned to another viewer when it is a restricted model's mature image", async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: 2 }] as never);
    for (const user of [null, { id: 6 }])
      expect(await sourceFor(user, { nsfwLevel: 4 }, 1 | 4)).toBeNull();
    // Its owner still sees it.
    expect(await sourceFor({ id: 5 }, { nsfwLevel: 4 }, 1 | 4)).toBe(2);
  });

  it('is returned to another viewer when it passes (control), and at their level', async () => {
    expect(await sourceFor({ id: 6 }, {})).toBe(2);
    expect(await sourceFor({ id: 6 }, { nsfwLevel: 4 }, 1 | 4)).toBe(2);
  });

  it.each([
    ['the model owner', { id: 5 }],
    ['a moderator', { id: 1, isModerator: true }],
  ])('is returned to %s whatever its state', async (_, user) => {
    expect(await sourceFor(user, { blockedFor: 'tos', nsfwLevel: 16 })).toBe(2);
  });
});

describe("a 3D model's thumbnail and rating", () => {
  const passing = {
    nsfwLevel: 1,
    ingestion: 'Scanned',
    blockedFor: null,
    needsReview: null,
    minor: false,
    poi: false,
  };
  const rated = (nsfwLevel: number) =>
    dbMock.dbRead.model3D.findUnique.mockImplementation((async (args: { select: Select }) =>
      applySelect({ ...MODEL, nsfwLevel }, args.select)) as never);

  it('leaves out a thumbnail the feed would not show, for another viewer, and keeps the source image', async () => {
    dbMock.dbRead.image.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => (where.id === 1 ? { ...passing, blockedFor: 'tos' } : passing)) as never);
    for (const user of [null, { id: 6 }]) {
      const model = await getModel3DById({ id: 9, user: user as never });
      expect(model.thumbnailImage).toBeNull();
      expect(model.sourceImage?.id).toBe(2);
    }
    // Its owner and moderators keep it.
    for (const user of [{ id: 5 }, { id: 1, isModerator: true }])
      expect((await getModel3DById({ id: 9, user: user as never })).thumbnailImage?.id).toBe(1);
  });

  it.each([
    ['rated above the viewer level', 4],
    ['unrated', 0],
  ])('is not found by another viewer when %s', async (_, level) => {
    rated(level);
    for (const user of [null, { id: 6 }])
      await expect(
        getModel3DById({ id: 9, user: user as never, browsingLevel: 1 })
      ).rejects.toThrow(/No 3D model/);
    for (const user of [{ id: 5 }, { id: 1, isModerator: true }])
      expect((await getModel3DById({ id: 9, user: user as never, browsingLevel: 1 })).id).toBe(9);
  });

  it('is found by a viewer whose level includes its rating (control)', async () => {
    rated(4);
    dbMock.dbRead.image.findUnique.mockResolvedValue({ ...passing, nsfwLevel: 4 } as never);
    expect(
      (await getModel3DById({ id: 9, user: { id: 6 } as never, browsingLevel: 1 | 4 })).id
    ).toBe(9);
  });
});
