import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactionEntityType } from '~/server/schema/reaction.schema';

type Row = Record<string, unknown>;

const matches = (where: Row) => (row: Row) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

function makeTable(rows: Row[]) {
  return {
    rows,
    findFirst: vi.fn(async ({ where }: { where: Row }) => rows.find(matches(where)) ?? null),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const kept = rows.filter((row) => !matches(where)(row));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      rows.push(data);
      return data;
    }),
  };
}

const REACTION_MODELS = [
  ['question', 'questionReaction', 'questionId'],
  ['answer', 'answerReaction', 'answerId'],
  ['commentOld', 'commentReaction', 'commentId'],
  ['comment', 'commentV2Reaction', 'commentId'],
  ['image', 'imageReaction', 'imageId'],
  ['post', 'postReaction', 'postId'],
  ['resourceReview', 'resourceReviewReaction', 'reviewId'],
  ['article', 'articleReaction', 'articleId'],
  ['bountyEntry', 'bountyEntryReaction', 'bountyEntryId'],
] as const satisfies readonly (readonly [ReactionEntityType, string, string])[];

// The subset whose deletes queue a metric update, i.e. the ones with an
// `if (count > 0)` guard to regress.
const METRIC_MODELS = REACTION_MODELS.filter(([entityType]) =>
  ['question', 'answer', 'post', 'article', 'bountyEntry'].includes(entityType)
);

const { mockDbWrite, mockDbReplica, mockQueueUpdate } = vi.hoisted(() => {
  const build = () =>
    Object.fromEntries(
      [
        'questionReaction',
        'answerReaction',
        'commentReaction',
        'commentV2Reaction',
        'imageReaction',
        'postReaction',
        'resourceReviewReaction',
        'articleReaction',
        'bountyEntryReaction',
      ].map((model) => [model, undefined])
    );
  return {
    mockDbWrite: build() as Record<string, ReturnType<typeof makeTable>>,
    mockDbReplica: build() as Record<string, ReturnType<typeof makeTable>>,
    mockQueueUpdate: vi.fn(async () => undefined),
  };
});

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite, dbRead: mockDbReplica }));
vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => mockDbReplica }));
vi.mock('~/server/metrics', () => {
  const metrics = { queueUpdate: mockQueueUpdate };
  return {
    answerMetrics: metrics,
    articleMetrics: metrics,
    bountyEntryMetrics: metrics,
    postMetrics: metrics,
    questionMetrics: metrics,
  };
});
vi.mock('~/server/services/block-check.service', () => ({
  throwIfBlockedByEntityOwner: vi.fn(async () => undefined),
}));

import { toggleReaction } from '~/server/services/reaction.service';

/** Seeds the replica with `replicaRows` and the primary with `primaryRows`. */
function seed(model: string, replicaRows: Row[], primaryRows: Row[]) {
  mockDbReplica[model] = makeTable(replicaRows);
  mockDbWrite[model] = makeTable(primaryRows);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleReaction — replica-lag un-react', () => {
  it('removes the primary row even when the replica returns a stale id', async () => {
    // The user reacted, un-reacted and re-reacted inside the replication window:
    // the replica still names the FIRST row (id 111), the primary holds the
    // third (id 222). A delete keyed on the replica's id matches nothing.
    seed(
      'imageReaction',
      [{ id: 111, imageId: 1, userId: 5, reaction: 'Like' }],
      [{ id: 222, imageId: 1, userId: 5, reaction: 'Like' }]
    );

    const result = await toggleReaction({
      entityType: 'image',
      entityId: 1,
      userId: 5,
      reaction: 'Like',
    });

    expect(mockDbWrite.imageReaction.rows).toHaveLength(0);
    expect(result).toBe('removed');
    expect(mockDbWrite.imageReaction.deleteMany).toHaveBeenCalledWith({
      where: { imageId: 1, userId: 5, reaction: 'Like' },
    });
  });

  it('reports noop, not removed, when the delete matched no row', async () => {
    seed('imageReaction', [{ id: 111, imageId: 1, userId: 5, reaction: 'Like' }], []);

    const result = await toggleReaction({
      entityType: 'image',
      entityId: 1,
      userId: 5,
      reaction: 'Like',
    });

    expect(result).toBe('noop');
  });

  it.each(REACTION_MODELS)(
    'deletes %s reactions by natural key, never by the replica-read id',
    async (entityType, model, foreignKey) => {
      seed(
        model,
        [{ id: 111, [foreignKey]: 7, userId: 5, reaction: 'Heart' }],
        [{ id: 222, [foreignKey]: 7, userId: 5, reaction: 'Heart' }]
      );

      const result = await toggleReaction({
        entityType,
        entityId: 7,
        userId: 5,
        reaction: 'Heart',
      });

      expect(mockDbWrite[model].rows).toHaveLength(0);
      expect(result).toBe('removed');

      // Exact shape, not merely "no id": a delete missing userId or reaction is
      // still natural-key-shaped and would wipe every user's reaction on the entity.
      const [{ where }] = mockDbWrite[model].deleteMany.mock.calls[0];
      expect(where).toEqual({ [foreignKey]: 7, userId: 5, reaction: 'Heart' });
    }
  );

  it.each(METRIC_MODELS)(
    'does not queue a %s metric update when the delete matched no row',
    async (entityType, model, foreignKey) => {
      seed(model, [{ id: 111, [foreignKey]: 7, userId: 5, reaction: 'Heart' }], []);

      const result = await toggleReaction({
        entityType,
        entityId: 7,
        userId: 5,
        reaction: 'Heart',
      });

      expect(result).toBe('noop');
      expect(mockQueueUpdate).not.toHaveBeenCalled();
    }
  );
});
