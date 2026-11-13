import { expect, test } from 'vitest';
import { commentV3Handler } from '@/handlers/comment-v3';

type Add = { entityType: string; entityId: number; as: number; metric: string; value: number };

function recorder() {
  const adds: Add[] = [];
  const actions = {
    forMetric: (entityType: string, entityId: number) => ({
      as: (as: number) => ({
        add: (metric: string, value: number) => {
          adds.push({ entityType, entityId, as, metric, value });
        },
      }),
    }),
  };
  return { adds, actions };
}

// The handler's owner resolution lives in SQL, so a fake `pg` cannot tell a correct join from one
// naming a column that does not exist — that half is verified by running the query against the real
// database, which nothing here re-runs. What these tests pin is everything downstream of the row:
// which metrics are emitted, for whom, with what sign, and off which bound parameter.
function pgReturning(row: unknown) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    pg: {
      queryOne: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return row;
      },
    },
    calls,
  };
}

function expectAdds(adds: Add[], expected: Add[]) {
  // Order between the entity emit and the owner emit is incidental, so it is not asserted — a
  // refactor that reorders them is not a regression. The length is, otherwise arrayContaining
  // would pass on a handler that emitted extra metrics. Note the pair only holds while `expected`
  // has no duplicate members: two identical Adds would both be satisfied by one, leaving the
  // length as the sole check.
  expect(adds).toHaveLength(expected.length);
  expect(adds).toEqual(expect.arrayContaining(expected));
}

const user = (entityId: number, as: number, value: number): Add => ({
  entityType: 'User',
  entityId,
  as,
  metric: 'commentCount',
  value,
});

const entity = (entityType: string, entityId: number, as: number, value: number): Add => ({
  entityType,
  entityId,
  as,
  metric: 'commentCount',
  value,
});

test('commentV3Handler emits nothing when the owner lookup fails', async () => {
  const record = { id: 1, userId: 42, entityType: 'model', entityId: 7, deletedAt: null };
  const { adds, actions } = recorder();
  const pg = {
    queryOne: async () => {
      throw new Error('connection terminated');
    },
  };

  // Both halves matter and neither is visible with a resolving fake. The throw has to propagate or
  // the Kafka offset commits over a message whose metrics were never queued; and nothing may be
  // emitted before it, because the batcher and Redis dedupe a replayed metric but
  // `metricSignals.sendDelta` does not — an emit above the await double-fires the live delta on
  // every retry. Moving an emit back above the query is otherwise invisible: with a resolving fake
  // both orderings produce identical output.
  await expect(
    commentV3Handler.process({ operation: 'create', record, actions, pg } as never)
  ).rejects.toThrow('connection terminated');
  expect(adds).toEqual([]);
});

const v3 = (
  operation: string,
  record: Record<string, unknown>,
  owner: unknown,
  change?: { old: unknown; current: unknown }
) => {
  const { adds, actions } = recorder();
  const { pg, calls } = pgReturning(owner);
  return commentV3Handler
    .process({
      operation,
      record: {
        id: 9,
        userId: 42,
        entityType: 'article',
        entityId: 77,
        deletedAt: null,
        ...record,
      },
      ...change,
      actions,
      pg,
    } as never)
    .then(() => ({ adds, calls }));
};

test('a CommentV3 article comment, reply or not, counts for the article and its owner', async () => {
  const { adds, calls } = await v3('create', {}, { ownerId: 555 });
  expectAdds(adds, [user(555, 42, 1), entity('Article', 77, 42, 1)]);
  expect(calls[0].params).toEqual([77]);
});

test('a CommentV3 delete backs a live comment out, and a tombstone only once', async () => {
  expectAdds((await v3('delete', {}, { ownerId: 555 })).adds, [
    user(555, 42, -1),
    entity('Article', 77, 42, -1),
  ]);
  const tombstoned = await v3(
    'update',
    { deletedAt: '2026-10-29T00:00:00Z' },
    { ownerId: 555 },
    { old: { deletedAt: null }, current: { deletedAt: '2026-10-29T00:00:00Z' } }
  );
  expectAdds(tombstoned.adds, [user(555, 42, -1), entity('Article', 77, 42, -1)]);
  // The tombstone's removal when its last reply goes, and any other update, count nothing.
  expect(
    (await v3('delete', { deletedAt: '2026-10-29T00:00:00Z' }, { ownerId: 555 })).adds
  ).toEqual([]);
  expect(
    (
      await v3(
        'update',
        {},
        { ownerId: 555 },
        { old: { deletedAt: null }, current: { deletedAt: null } }
      )
    ).adds
  ).toEqual([]);
});

test('CommentV3 skips self-comments for the owner and surfaces it does not count', async () => {
  expectAdds((await v3('create', {}, { ownerId: 42 })).adds, [entity('Article', 77, 42, 1)]);
  // Crucible and storyline are not counted.
  for (const entityType of ['crucible', 'storyline'])
    expect((await v3('create', { entityType }, { ownerId: 555 })).adds).toEqual([]);
});

test.each([
  ['image', 'Image'],
  ['post', 'Post'],
  ['bounty', 'Bounty'],
  ['model', 'Model'],
])('a CommentV3 %s comment counts for the entity and its owner', async (entityType, metric) => {
  const { adds, calls } = await v3('create', { entityType }, { ownerId: 555 });
  expectAdds(adds, [user(555, 42, 1), entity(metric, 77, 42, 1)]);
  expect(calls[0].sql).toContain(`FROM "${metric}" WHERE id = $1`);
});

// Pin the owner query's table and columns: a wrong name throws in production and stalls the topic,
// and a canned owner row would hide it.
test.each([
  ['review', ['"ResourceReview"', '"userId"', 'id = $1']],
  ['bountyEntry', ['"BountyEntry"', '"userId"', 'id = $1']],
  ['challenge', ['"Challenge"', '"createdById"', 'id = $1']],
  ['model3d', ['"Model3D"', '"userId"', 'id = $1']],
  ['model3dReview', ['"Model3DReview"', '"userId"', 'id = $1']],
  ['appListing', ['app_listings', 'user_id', 'serial_id = $1']],
  [
    'comicChapter',
    ['"ComicChapter" c', 'JOIN "ComicProject" p ON p.id = c."projectId"', 'p."userId"'],
  ],
])('a CommentV3 %s comment counts for its owner only', async (entityType, sqlParts) => {
  const { adds, calls } = await v3('create', { entityType }, { ownerId: 555 });
  expectAdds(adds, [user(555, 42, 1)]);
  expect(calls[0].params).toEqual([77]);
  for (const part of sqlParts) expect(calls[0].sql).toContain(part);
});
