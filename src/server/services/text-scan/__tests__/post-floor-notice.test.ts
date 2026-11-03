import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as Adapters from '~/server/services/moderation-adapters';
import type * as RatingReviewService from '~/server/services/rating-review.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The real text-scan callback and the real UpdateNsfwLevel job recompute over one post, against a fake
// database that derives the post's level as the SQL does.

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanCsamMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  getModerationAdapter: vi.fn(),
}));
vi.mock('~/server/services/rating-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RatingReviewService>()),
  maybeAutoResolveRatingDisputeAfterScan: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { getWorkflow } = await import('@civitai/orchestration-client');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { postTextScanAdapter } = await import('~/server/services/text-scan/adapters');
const { updateNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { createNotification } = await import('~/server/services/notification.service');

const POST_ID = 7;
const OWNER = 5;
const FLOOR = 8;

registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  load: async () => new Map([[POST_ID, { userId: OWNER, fields: [], declared: { nsfwLevel: 0 } }]]),
});

const RAISED = { nsfw: { level: 'x', reason: 'r' } };
const raisedWorkflow = {
  data: {
    metadata: {
      entityType: 'Post',
      entityId: POST_ID,
      emEntityType: 'Post',
      mode: 'active',
      externalId: 'ts-Post-7-abc-0-0',
      labels: ['nsfw'],
      promptIds: { base: 1, nsfw: 2 },
      model: 'air:test',
    },
    tags: ['text-scan'],
    steps: [
      {
        $type: 'chatCompletion',
        name: 'textScan',
        metadata: { segment: 0 },
        output: {
          choices: [{ message: { content: JSON.stringify(RAISED) }, finishReason: 'stop' }],
          parsed: RAISED,
        },
      },
    ],
  },
};

type Verdict = {
  workflowId: string;
  nsfwLevel: number | null;
  triggeredLabels: string[];
  result: unknown;
};
let post: { images: number; level: number; moderatorNsfwLevel: number | null };
let verdict: Verdict | null;
const raisedVerdict = (triggeredLabels = ['nsfw']): Verdict => ({
  workflowId: 'wf-1',
  nsfwLevel: FLOOR,
  triggeredLabels,
  result: { version: 1 },
});

// scanFloorText and raiseNsfwLevelText in packages/civitai-shared/src/rated-entity-sql.ts.
const derivedLevel = () => {
  const usable = verdict && (verdict.result as { version?: number } | null)?.version != null;
  const f = usable && (verdict?.nsfwLevel ?? 0) >= 2 ? verdict!.nsfwLevel! : 0;
  const l = post.images;
  const raised = l === 0 || f === 0 ? l : (l & ~(f - 1)) === 0 ? f : l & ~(f - 1);
  return post.moderatorNsfwLevel ?? raised;
};

// A fake for the two raw statements this path sends; anything else fails the test.
const fakeRaw = async (query: Prisma.Sql) => {
  const sql = query.text.replace(/\s+/g, ' ').trim();
  if (sql.startsWith('WITH next AS') && sql.includes('UPDATE "Post" p')) {
    const before = post.level;
    const after = derivedLevel();
    if (after === before) return [];
    post.level = after;
    return sql.includes('RETURNING p.id, next."before", p."nsfwLevel" "after"')
      ? [{ id: POST_ID, before, after }]
      : [];
  }
  if (sql.includes('FROM "Post" p JOIN "EntityModeration" em')) {
    expect(query.values).toEqual([POST_ID]);
    if (!verdict) return [];
    if (
      sql.includes(`'nsfw' = ANY(em."triggeredLabels")`) &&
      !verdict.triggeredLabels.includes('nsfw')
    )
      return [];
    return [
      {
        id: POST_ID,
        userId: OWNER,
        title: 'T',
        moderatorNsfwLevel: post.moderatorNsfwLevel,
        workflowId: verdict.workflowId,
        triggeredLabels: verdict.triggeredLabels,
        images: post.images,
      },
    ];
  }
  throw new Error(`unexpected raw query: ${sql}`);
};

const ratingNotices = () =>
  vi.mocked(createNotification).mock.calls.filter(([n]) => n.type === 'text-scan-rating-raised');

// What the UpdateNsfwLevel job runs once an image's level changes.
const imageRated = async (imageLevel: number) => {
  post.images |= imageLevel;
  await updateNsfwLevels({
    postIds: [POST_ID],
    articleIds: [],
    bountyIds: [],
    bountyEntryIds: [],
    collectionIds: [],
    modelIds: [],
    modelVersionIds: [],
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  post = { images: 0, level: 0, moderatorNsfwLevel: null };
  verdict = null;
  vi.mocked(getModerationAdapter).mockReturnValue(postTextScanAdapter);
  dbMock.dbWrite.post.findUnique.mockImplementation((async () => ({
    nsfwLevel: post.level,
    moderatorNsfwLevel: post.moderatorNsfwLevel,
    userId: OWNER,
    title: 'T',
  })) as never);
  dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => verdict) as never);
  dbMock.dbWrite.entityModeration.updateMany.mockImplementation((async ({
    data,
  }: {
    data: Partial<Verdict>;
  }) => {
    if (data.nsfwLevel) {
      verdict = {
        workflowId: data.workflowId ?? 'missing',
        nsfwLevel: data.nsfwLevel,
        triggeredLabels: data.triggeredLabels ?? [],
        result: data.result ?? null,
      };
    }
    return { count: 1 };
  }) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(fakeRaw as never);
});

describe('rating-raised notice when the floor lands on the level recompute', () => {
  it('notifies once when the verdict lands before the post has a rating', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(raisedWorkflow as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(post.level).toBe(0);
    expect(ratingNotices()).toHaveLength(0);

    await imageRated(1);
    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
    expect(ratingNotices()[0][0]).toMatchObject({
      userId: OWNER,
      key: `text-scan-rating-raised-Post-${POST_ID}-${FLOOR}-wf-1`,
      details: { level: FLOOR, url: `/posts/${POST_ID}` },
    });
  });

  it('sends no second notice after the callback notified', async () => {
    post.images = 1;
    post.level = 1;
    vi.mocked(getWorkflow).mockResolvedValue(raisedWorkflow as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(ratingNotices()).toHaveLength(1);

    await imageRated(2);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
  });

  it('does not notify when the images reach the level on their own', async () => {
    verdict = raisedVerdict();

    await imageRated(FLOOR);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('does not notify when the level falls to the floor', async () => {
    verdict = raisedVerdict();
    await imageRated(16);
    expect(post.level).toBe(16);

    post.images = 0;
    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('does not notify a post with a moderator rating', async () => {
    verdict = raisedVerdict();
    post.moderatorNsfwLevel = FLOOR;

    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it.each(['poi', 'minor'])('does not notify a raise deferred for %s', async (label) => {
    verdict = raisedVerdict(['nsfw', label]);

    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('does not notify a floor at the level the owner declared', async () => {
    verdict = raisedVerdict([]);

    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('still applies the level when the notice lookup fails', async () => {
    verdict = raisedVerdict();
    dbMock.dbWrite.$queryRaw.mockImplementation((async (query: Prisma.Sql) => {
      if (query.text.includes('JOIN "EntityModeration" em')) throw new Error('read failed');
      return fakeRaw(query);
    }) as never);

    await expect(imageRated(1)).resolves.toBeUndefined();

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });
});
