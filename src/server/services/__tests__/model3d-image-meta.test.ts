import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

const { getModel3DById, getModel3DsInfinite } = await import('~/server/services/model3d.service');

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
});
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
});

describe('a 3D model page', () => {
  it("never returns its source image's or thumbnail's generation data, to anyone", async () => {
    for (const user of [null, { id: 6 }, { id: 5 }, { id: 1, isModerator: true }]) {
      const model = await getModel3DById({ id: 9, user: user as never });
      expect(model.sourceImage?.id).toBe(2);
      expect(model.thumbnailImage?.id).toBe(1);
      expect(model.sourceImage).not.toHaveProperty('meta');
      expect(model.thumbnailImage).not.toHaveProperty('meta');
    }
  });

  it("the feed never returns a card thumbnail's generation data", async () => {
    const { items } = await getModel3DsInfinite({ limit: 10, user: null } as never);
    expect(items[0]?.thumbnailImage?.id).toBe(1);
    expect(items[0]?.thumbnailImage).not.toHaveProperty('meta');
  });
});

describe('a 3D model page whose images are restricted by their base model', () => {
  const restricted = (id: number, nsfwLevel: number) => ({
    ...image(id),
    nsfwLevel,
    modelRestricted: true,
  });
  const pageImages = async (nsfwLevel: number, user: unknown) => {
    const model = {
      ...MODEL,
      thumbnailImage: restricted(1, nsfwLevel),
      sourceImage: restricted(2, nsfwLevel),
    };
    dbMock.dbRead.model3D.findUnique.mockImplementation((async (args: { select: Select }) =>
      applySelect(model, args.select)) as never);
    const page = await getModel3DById({ id: 9, user: user as never });
    return [page.thumbnailImage?.id ?? null, page.sourceImage?.id ?? null];
  };

  it.each([
    ['a stranger', { id: 6 }],
    ['a moderator', { id: 1, isModerator: true }],
  ])('withholds mature ones from %s', async (_, user) => {
    expect(await pageImages(4, user)).toEqual([null, null]);
    expect(await pageImages(1, user)).toEqual([1, 2]);
  });

  it('shows them to their uploader', async () => {
    expect(await pageImages(4, { id: 5 })).toEqual([1, 2]);
  });
});
