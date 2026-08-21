import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { toggleHidden } from '~/server/services/user-preferences.service';

/**
 * 868kurkc7. Every engagement table is one row per (user, entity) carrying ONE
 * `type`, so the types are mutually exclusive by construction. These toggles read
 * the row, branch on that read, then wrote addressed by the PRIMARY KEY alone — so
 * the write landed on whatever type occupied the row, including one a sibling writer
 * established a millisecond earlier, and reported success. `UserEngagement` had this
 * fixed by PR #4230; these five carried the same shape.
 *
 * Unlike `UserEngagement` (Block > Hide > Follow) these tables have NO precedence
 * order, so the only guard available is the type the call actually observed: a writer
 * replaces what it saw, or nothing.
 *
 * A race cannot be scheduled from a test. The property that CAN be asserted is that
 * no writer is capable of one — hence the shape assertions rather than interleavings.
 */

const userId = 42;
const entityId = 10;

const TABLES = [
  {
    kind: 'image' as const,
    table: dbMock.dbWrite.imageEngagement,
    scoped: { userId, imageId: entityId },
    // The other type this table holds, i.e. what an unqualified write destroys.
    sibling: 'Favorite',
  },
  {
    kind: 'model' as const,
    table: dbMock.dbWrite.modelEngagement,
    scoped: { userId, modelId: entityId },
    sibling: 'Notify',
  },
  {
    kind: 'model3d' as const,
    table: dbMock.dbWrite.model3DEngagement,
    scoped: { userId, model3dId: entityId },
    sibling: 'Notify',
  },
];

const hide = (kind: (typeof TABLES)[number]['kind'] | 'tag', hidden?: boolean) =>
  toggleHidden({ kind, data: [{ id: entityId }], hidden, userId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  for (const { table } of TABLES) {
    table.findUnique.mockResolvedValue(null);
    table.create.mockResolvedValue({});
    table.deleteMany.mockResolvedValue({ count: 1 });
    table.updateMany.mockResolvedValue({ count: 1 });
  }
  dbMock.dbWrite.tagEngagement.findMany.mockResolvedValue([]);
  dbMock.dbWrite.tagEngagement.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.tagEngagement.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.tagEngagement.createMany.mockResolvedValue({ count: 0 });
  dbMock.dbRead.tagsOnImageVote.findMany.mockResolvedValue([]);
});

describe.each(TABLES)('toggleHidden kind=$kind — writes are scoped by type', (t) => {
  it('issues no PK-addressed write, whatever type holds the row', async () => {
    for (const type of ['Hide', t.sibling]) {
      t.table.findUnique.mockResolvedValue({ type });
      await hide(t.kind);
    }

    expect([...t.table.delete.mock.calls, ...t.table.update.mock.calls]).toEqual([]);
  });

  it(`un-hiding removes a Hide and leaves a ${t.sibling} alone`, async () => {
    t.table.findUnique.mockResolvedValue({ type: 'Hide' });

    await hide(t.kind);

    // The `type` filter IS the fix: unqualified, this same statement deleted whatever
    // the row had become between the read and here.
    expect(t.table.deleteMany).toHaveBeenCalledWith({ where: { ...t.scoped, type: 'Hide' } });
  });

  it('converting to Hide can only replace the type it read', async () => {
    t.table.findUnique.mockResolvedValue({ type: t.sibling });

    await hide(t.kind);

    expect(t.table.updateMany).toHaveBeenCalledWith({
      where: { ...t.scoped, type: t.sibling },
      data: { type: 'Hide' },
    });
    expect(t.table.deleteMany).not.toHaveBeenCalled();
  });

  it('creates the row when the pair has none', async () => {
    await hide(t.kind);

    // Paired with the cases above so the scoping assertions are not passing on a
    // toggle that stopped writing at all.
    expect(t.table.create).toHaveBeenCalledTimes(1);
    expect(t.table.updateMany).not.toHaveBeenCalled();
    expect(t.table.deleteMany).not.toHaveBeenCalled();
  });
});

// The tag toggle is the one that disagreed with itself: the `hidden === false` branch
// already filtered `type: 'Hide'`, the two statements inside the `else` did not.
describe('toggleHidden kind=tag — writes are scoped by type', () => {
  const tags = dbMock.dbWrite.tagEngagement;

  it('un-hiding removes only the Hide rows', async () => {
    tags.findMany.mockResolvedValue([{ tagId: entityId, type: 'Hide' }]);

    await hide('tag', undefined);

    expect(tags.deleteMany).toHaveBeenCalledWith({
      where: { userId, tagId: { in: [entityId] }, type: 'Hide' },
    });
  });

  it('converts each row against the type it was READ as', async () => {
    // Two types in one batch, which is why the statement cannot simply carry
    // `type: { not: 'Hide' }` and call itself scoped.
    tags.findMany.mockResolvedValue([
      { tagId: 1, type: 'Follow' },
      { tagId: 2, type: 'Allow' },
    ]);

    await toggleHidden({ kind: 'tag', data: [{ id: 1 }, { id: 2 }], hidden: true, userId });

    expect(tags.updateMany).toHaveBeenCalledWith({
      where: { userId, tagId: { in: [1] }, type: 'Follow' },
      data: { type: 'Hide' },
    });
    expect(tags.updateMany).toHaveBeenCalledWith({
      where: { userId, tagId: { in: [2] }, type: 'Allow' },
      data: { type: 'Hide' },
    });
    expect(tags.updateMany).toHaveBeenCalledTimes(2);
  });
});
