import { expect, test } from 'vitest';
import { commentV2Handler } from '@/handlers/comment-v2';
import { COMMENT_V3_SURFACES, commentV3Handler } from '@/handlers/comment-v3';

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

const uncountedSurfaceThread = { surface: null };

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

test('a comment on a surface with no entity metric still counts toward its owner', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...uncountedSurfaceThread, ownerId: 555 });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expectAdds(adds, [user(555, 42, 1)]);
});

test('self-authored comments are excluded', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...uncountedSurfaceThread, ownerId: 42 });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expect(adds).toEqual([]);
});

test('an unresolved owner emits nothing rather than a metric keyed on null', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...uncountedSurfaceThread, ownerId: null });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expect(adds).toEqual([]);
});

test('a thread that no longer exists is skipped without throwing', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning(null);

  // A deleted thread is a live case, not a hypothetical: the CDC delete for a comment can arrive
  // after its thread is gone. Throwing here poisons the Kafka message rather than dropping a metric.
  await commentV2Handler.process({
    operation: 'delete',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expect(adds).toEqual([]);
});

test.each(COMMENT_V3_SURFACES)('a %s comment is left to the CommentV3 handler', async (surface) => {
  for (const operation of ['create', 'delete']) {
    const { adds, actions } = recorder();
    const { pg } = pgReturning({ surface, ownerId: 555 });
    await commentV2Handler.process({
      operation,
      record: { userId: 42, threadId: 1 },
      actions,
      pg,
    } as never);
    expect(adds).toEqual([]);
  }
});

test('a delete backs out the owner count', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...uncountedSurfaceThread, ownerId: 555 });

  await commentV2Handler.process({
    operation: 'delete',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expectAdds(adds, [user(555, 42, -1)]);
});

test('the owner is looked up by thread, not by commenter', async () => {
  const { actions } = recorder();
  const { pg, calls } = pgReturning({ ...uncountedSurfaceThread, ownerId: 555 });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1234 },
    actions,
    pg,
  } as never);

  // Binding the wrong record field resolves a real row for the wrong entity, which is invisible in
  // the emissions above — every metric still looks well-formed, just attributed to a stranger.
  expect(calls[0].params).toEqual([1234]);
  // One round trip per event, on a Kafka-rate path.
  expect(calls).toHaveLength(1);
});

// A tripwire for accidental deletion, and nothing more. It checks that the query still MENTIONS
// every surface; it cannot check that the query resolves one. An adversarial pass walked straight
// through it while leaving every string below intact — deleting `i."userId"` from the owner
// COALESCE and adding `AND i."userId" IS NOT NULL` to the Image join stops every image comment
// counting toward its creator and this test still passes, as do `AND false` on a join, restricting
// to non-reply threads, and `LIMIT 0`. Adding more substrings cannot close that: the mutation works
// by keeping the substring. Only executing the query against a seeded database would.
test('the owner query still mentions every commentable surface', async () => {
  const { actions } = recorder();
  const { pg, calls } = pgReturning({ ...uncountedSurfaceThread, ownerId: 1 });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  const sql = calls[0].sql;

  // Asserted as the whole COALESCE rather than as a bare column name: a reply carries no entity FK
  // of its own, so collapsing `COALESCE(r.x, t.x)` to `t.x` silently drops every reply — while the
  // column name it was named after is still right there in the string.
  for (const column of [
    'postId',
    'imageId',
    'articleId',
    'bountyId',
    'reviewId',
    'bountyEntryId',
    'challengeId',
    'comicProjectId',
    'clubPostId',
    'model3dId',
    'model3dReviewId',
    'modelId',
    'appListingId',
  ]) {
    expect(sql).toContain(`= COALESCE(r."${column}", t."${column}")`);
  }

  // The surface is classified with the same fallback, or a reply on a CommentV3 surface would
  // classify as none and be counted twice.
  const surfaceColumn: Record<(typeof COMMENT_V3_SURFACES)[number], string> = {
    article: 'articleId',
    post: 'postId',
    image: 'imageId',
    review: 'reviewId',
    bounty: 'bountyId',
    bountyEntry: 'bountyEntryId',
    challenge: 'challengeId',
    crucible: 'crucibleId',
    storyline: 'storylineId',
    model3d: 'model3dId',
    appListing: 'appListingId',
    comicChapter: 'comicProjectId',
    model: 'modelId',
  };
  for (const surface of COMMENT_V3_SURFACES) {
    const column = surfaceColumn[surface];
    expect(sql).toContain(
      `WHEN COALESCE(r."${column}", t."${column}") IS NOT NULL THEN '${surface}'`
    );
  }

  // And the root thread has to be joined on rootThreadId — joined on anything else, every COALESCE
  // above resolves against the reply's own empty columns.
  expect(sql).toContain('LEFT JOIN "Thread" r ON r.id = t."rootThreadId"');

  // The owner expressions are asserted separately from the column names because a surface can be
  // joined and still resolve nobody: drop `al.user_id` from the owner COALESCE and every FK name
  // above is still present, the join is still there, and app listings silently stop counting.
  for (const owner of [
    'p."userId"',
    'i."userId"',
    'a."userId"',
    'b."userId"',
    'rev."userId"',
    'be."userId"',
    'ch."createdById"',
    'cp."userId"',
    'clp."createdById"',
    'm3d."userId"',
    'm3dr."userId"',
    'mdl."userId"',
    'al.user_id',
  ]) {
    expect(sql).toContain(owner);
  }
});

test.each([['commentV2Handler', commentV2Handler, { userId: 42, threadId: 1 }]])(
  '%s emits nothing when the owner lookup fails',
  async (_name, handler, record) => {
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
      handler.process({ operation: 'create', record, actions, pg } as never)
    ).rejects.toThrow('connection terminated');
    expect(adds).toEqual([]);
  }
);

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
