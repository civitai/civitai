import { expect, test } from 'vitest';
import { commentV2Handler } from '@/handlers/comment-v2';
import { commentHandler } from '@/handlers/comments';

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

const noEntity = {
  postId: null,
  imageId: null,
  articleId: null,
  bountyId: null,
};

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
  const { pg } = pgReturning({ ...noEntity, ownerId: 555 });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  // A review/model/challenge/comic thread resolves no Post/Image/Article/Bounty id at all, so this
  // is the whole emission for those surfaces — the 45% the metric used to miss.
  expectAdds(adds, [user(555, 42, 1)]);
});

test('self-authored comments are excluded', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...noEntity, ownerId: 42 });

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
  const { pg } = pgReturning({ ...noEntity, ownerId: null });

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

test.each([
  ['post', 'postId', 'Post'],
  ['image', 'imageId', 'Image'],
  ['article', 'articleId', 'Article'],
  ['bounty', 'bountyId', 'Bounty'],
])('a %s comment counts for the entity and its owner', async (_name, idField, entityType) => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...noEntity, [idField]: 77, ownerId: 555 });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expectAdds(adds, [user(555, 42, 1), entity(entityType, 77, 42, 1)]);
});

test('a delete backs out both the entity and the owner', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...noEntity, imageId: 77, ownerId: 555 });

  await commentV2Handler.process({
    operation: 'delete',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expectAdds(adds, [user(555, 42, -1), entity('Image', 77, 42, -1)]);
});

test('the owner is looked up by thread, not by commenter', async () => {
  const { actions } = recorder();
  const { pg, calls } = pgReturning({ ...noEntity, ownerId: 555 });

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
  const { pg, calls } = pgReturning({ ...noEntity, ownerId: 1 });

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
    'questionId',
    'answerId',
    'appListingId',
  ]) {
    expect(sql).toContain(`= COALESCE(r."${column}", t."${column}")`);
  }

  // The four ids that are also selected carry the same fallback twice — once to find the owner and
  // once to decide which entity metric to emit. Asserting only the join form leaves the selected
  // half free to collapse to `t.x`, which drops every reply from the entity counts alone.
  for (const column of ['postId', 'imageId', 'articleId', 'bountyId']) {
    expect(sql).toContain(`COALESCE(r."${column}", t."${column}") AS "${column}"`);
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
    'q."userId"',
    'ans."userId"',
    'al.user_id',
  ]) {
    expect(sql).toContain(owner);
  }
});

test('a model comment counts for the model and its creator', async () => {
  const { adds, actions } = recorder();
  const { pg, calls } = pgReturning({ userId: 555 });

  await commentHandler.process({
    operation: 'create',
    record: { userId: 42, modelId: 9 },
    actions,
    pg,
  } as never);

  expectAdds(adds, [entity('Model', 9, 42, 1), user(555, 42, 1)]);
  expect(calls[0].params).toEqual([9]);
});

test('deleting a model comment backs out both counts', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ userId: 555 });

  // Without this, a sign flip on the delete path inflates the largest comment surface on the site
  // forever — nothing replays these events to repair it.
  await commentHandler.process({
    operation: 'delete',
    record: { userId: 42, modelId: 9 },
    actions,
    pg,
  } as never);

  expectAdds(adds, [entity('Model', 9, 42, -1), user(555, 42, -1)]);
});

test('a creator commenting on their own model counts for the model but not for themselves', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ userId: 42 });

  await commentHandler.process({
    operation: 'create',
    record: { userId: 42, modelId: 9 },
    actions,
    pg,
  } as never);

  expectAdds(adds, [entity('Model', 9, 42, 1)]);
});
