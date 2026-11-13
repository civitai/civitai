import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getModel3DById,
  getModel3DByPostId,
  getModel3DFiles,
  getModel3DsInfinite,
  getVisibleModel3DIds,
} from '~/server/services/model3d.service';
import { getModel3DReviews } from '~/server/services/model3d-review.service';
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

/** Only the columns a query's `select` asks for, as Prisma returns them. */
const pick = (row: Row | undefined, select?: Record<string, unknown>): Row | null => {
  if (!row) return null;
  if (Array.isArray(row)) return row.map((r) => pick(r, select)) as never;
  if (!select) return row;
  return Object.fromEntries(
    Object.entries(select)
      .filter(([key, want]) => want && key in row)
      .map(([key, want]) => [
        key,
        typeof want === 'object' && (want as { select?: Record<string, unknown> }).select
          ? pick(row[key] as Row, (want as { select: Record<string, unknown> }).select)
          : row[key],
      ])
  );
};

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
].map((row) => ({ ...row, files: [] }));

const anon = null;
const stranger = { id: 6 };
const owner = { id: OWNER };
const moderator = { id: 1, isModerator: true };

beforeEach(() => {
  type Args = { where: Where; select?: Record<string, unknown> };
  dbMock.dbRead.model3D.findUnique.mockImplementation((async ({ where, select }: Args) =>
    pick(
      ROWS.find((r) => r.id === where.id),
      select
    )) as never);
  dbMock.dbRead.model3D.findMany.mockImplementation((async ({ where, select }: Args) =>
    ROWS.filter((r) => matches(r, where)).map((r) => pick(r, select))) as never);
  // A post linked to the removed model.
  dbMock.dbRead.post.findUnique.mockImplementation((async ({ select }: Args) =>
    pick({ model3d: ROWS[1] }, select)) as never);
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

describe("a removed 3D model's other reads", () => {
  const hidden = [
    ['anonymous', anon],
    ['another user', stranger],
  ] as const;
  const shown = [
    ['its owner', owner],
    ['a moderator', moderator],
  ] as const;

  it.each(hidden)('its files are not found for %s', async (_, user) => {
    await expect(getModel3DFiles({ input: { id: 2 }, user: user as never })).rejects.toThrow(
      /No 3D model/
    );
    // An unflagged model's files are (control).
    await expect(getModel3DFiles({ input: { id: 1 }, user: user as never })).resolves.toBeDefined();
  });

  it.each(shown)('its files are served to %s', async (_, user) => {
    await expect(getModel3DFiles({ input: { id: 2 }, user: user as never })).resolves.toBeDefined();
  });

  it.each([...hidden.map(([w, u]) => [w, u, false]), ...shown.map(([w, u]) => [w, u, true])])(
    'its post chip, for %s, shows only when allowed',
    async (_, user, shows) => {
      const viewer = user as { id?: number; isModerator?: boolean } | null;
      const chip = await getModel3DByPostId({
        postId: 7,
        userId: viewer?.id,
        isModerator: viewer?.isModerator,
      });
      expect(chip?.id ?? null).toBe(shows ? 2 : null);
    }
  );

  it.each([...hidden.map(([w, u]) => [w, u, [1]]), ...shown.map(([w, u]) => [w, u, [1, 2]])])(
    'attaches to an image feed, for %s, only the models they may see',
    async (_, user, ids) => {
      const viewer = user as { id?: number; isModerator?: boolean } | null;
      const visible = await getVisibleModel3DIds({
        model3dIds: [1, 2],
        userId: viewer?.id,
        isModerator: viewer?.isModerator,
      });
      expect([...visible].sort()).toEqual(ids);
    }
  );

  it.each([...hidden.map(([w, u]) => [w, u, 0]), ...shown.map(([w, u]) => [w, u, 1])])(
    'its reviews are listed for %s only when allowed',
    async (_, user, count) => {
      dbMock.dbRead.model3DReview.findMany.mockResolvedValue([{ id: 50 }] as never);
      dbMock.dbRead.model3DReview.count.mockResolvedValue(1 as never);
      const page = await getModel3DReviews({
        input: { model3dId: 2, limit: 10, page: 1 } as never,
        user: user as never,
      });
      expect(page.items).toHaveLength(count);
    }
  );
});
