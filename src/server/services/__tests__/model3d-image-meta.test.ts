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

const image = (id: number) => ({
  id,
  userId: 5,
  url: `img-${id}`,
  hideMeta: true,
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
  expect(img).not.toHaveProperty('metadata');
};
const MODEL = {
  id: 9,
  name: 'model',
  userId: 5,
  status: Model3DStatus.Published,
  deletedAt: null,
  thumbnailImage: image(1),
  sourceImage: image(2),
  tags: [],
};

beforeEach(() => {
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
