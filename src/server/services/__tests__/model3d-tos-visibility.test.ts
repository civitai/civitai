import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getModel3DById, getModel3DsInfinite } from '~/server/services/model3d.service';
import { Model3DStatus } from '~/shared/utils/prisma/enums';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Prisma `where` over a flat row: equality, `in`, `not`, AND/OR. Refuses a column the row lacks. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (!(key in row)) throw new Error(`The fake has no column ${key}`);
    if (cond === null || typeof cond !== 'object') return row[key] === cond;
    const op = cond as { in?: unknown[]; not?: unknown };
    if ('in' in op) return op.in!.includes(row[key]);
    if ('not' in op) return row[key] !== op.not;
    return true;
  });
}

const OWNER = 5;
const base = {
  userId: OWNER,
  status: Model3DStatus.Published,
  deletedAt: null,
  nsfwLevel: 1,
  tags: [],
  thumbnailImage: null,
  sourceImage: null,
};
const ROWS: Row[] = [
  { ...base, id: 1, tosViolation: false },
  { ...base, id: 2, tosViolation: true },
];

const anon = null;
const stranger = { id: 6 };
const owner = { id: OWNER };
const moderator = { id: 1, isModerator: true };

beforeEach(() => {
  dbMock.dbRead.model3D.findUnique.mockImplementation(
    (async ({ where }: { where: Where }) => ROWS.find((r) => r.id === where.id) ?? null) as never
  );
  dbMock.dbRead.model3D.findMany.mockImplementation((async ({ where }: { where: Where }) =>
    ROWS.filter((r) => matches(r, where))) as never);
  dbMock.dbRead.model3DReview.findUnique.mockResolvedValue(null as never);
  dbMock.dbRead.model3DReview.findMany.mockResolvedValue([] as never);
});

describe('a 3D model a moderator removed', () => {
  it.each([
    ['anonymous', anon],
    ['another user', stranger],
  ])('is not found by id for %s, the same as an unknown id', async (_, user) => {
    const unknown = await getModel3DById({ id: 404, user: user as never }).catch((e) => e);
    const removed = await getModel3DById({ id: 2, user: user as never }).catch((e) => e);
    expect(removed.code).toBe('NOT_FOUND');
    expect(removed.code).toBe(unknown.code);
    expect(removed.message.replace('2', '#')).toBe(unknown.message.replace('404', '#'));
  });

  it.each([
    ['its owner', owner],
    ['a moderator', moderator],
  ])('is found by id for %s', async (_, user) => {
    const model = await getModel3DById({ id: 2, user: user as never });
    expect(model.id).toBe(2);
  });

  it.each([
    ['anonymous', anon, [1]],
    ['another user', stranger, [1]],
    ['its owner', owner, [1, 2]],
    ['a moderator', moderator, [1, 2]],
  ])('in the feed, for %s', async (_, user, ids) => {
    const { items } = await getModel3DsInfinite({
      limit: 20,
      browsingLevel: 1,
      user: user as never,
    } as never);
    expect(items.map((m) => m.id).sort()).toEqual(ids);
  });
});
