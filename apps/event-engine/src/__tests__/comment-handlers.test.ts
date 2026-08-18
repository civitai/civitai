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
// naming a column that does not exist — that half is verified by running the query against the
// real database. What these tests pin is everything downstream of the row: which metrics are
// emitted, for whom, and the self-authored exclusion.
function pgReturning(row: unknown) {
  const seen: string[] = [];
  return {
    pg: {
      queryOne: async (sql: string) => {
        seen.push(sql);
        return row;
      },
    },
    seen,
  };
}

const noEntity = {
  postId: null,
  imageId: null,
  articleId: null,
  bountyId: null,
};

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
  expect(adds).toEqual([
    { entityType: 'User', entityId: 555, as: 42, metric: 'commentCount', value: 1 },
  ]);
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

test('an image comment counts for both the image and its owner, and a delete backs both out', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ ...noEntity, imageId: 77, ownerId: 555 });

  await commentV2Handler.process({
    operation: 'delete',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  expect(adds).toEqual([
    { entityType: 'User', entityId: 555, as: 42, metric: 'commentCount', value: -1 },
    { entityType: 'Image', entityId: 77, as: 42, metric: 'commentCount', value: -1 },
  ]);
});

test('every commentable Thread column is resolved by the owner query', async () => {
  const { actions } = recorder();
  const { pg, seen } = pgReturning({ ...noEntity, ownerId: 1 });

  await commentV2Handler.process({
    operation: 'create',
    record: { userId: 42, threadId: 1 },
    actions,
    pg,
  } as never);

  // Dropping an arm from the query is invisible to the assertions above — they feed the handler a
  // row it never had to derive. This is the check that fails when a surface stops being resolved.
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
    expect(seen[0]).toContain(`"${column}"`);
  }
});

test('a model comment counts for the model and its creator', async () => {
  const { adds, actions } = recorder();
  const { pg } = pgReturning({ userId: 555 });

  await commentHandler.process({
    operation: 'create',
    record: { userId: 42, modelId: 9 },
    actions,
    pg,
  } as never);

  expect(adds).toEqual([
    { entityType: 'Model', entityId: 9, as: 42, metric: 'commentCount', value: 1 },
    { entityType: 'User', entityId: 555, as: 42, metric: 'commentCount', value: 1 },
  ]);
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

  expect(adds).toEqual([
    { entityType: 'Model', entityId: 9, as: 42, metric: 'commentCount', value: 1 },
  ]);
});
