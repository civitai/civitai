import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as Adapters from '~/server/services/moderation-adapters';
import type * as RatingReviewService from '~/server/services/rating-review.service';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// The real text-scan callback and the real image-scan side effects over one post. The post's level
// is derived as the database derives it: an unrated post (images at 0) stays 0 whatever the floor.

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
// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateArticleNsfwLevels: vi.fn(),
  updatePostNsfwLevels: vi.fn(),
  updateBountyNsfwLevels: vi.fn(),
  updateBountyEntryNsfwLevels: vi.fn(),
  updateModel3DNsfwLevelForThumbnailImage: vi.fn(),
  updateComicNsfwLevelsForImage: vi.fn(),
  queueComicsForPanelImage: vi.fn(),
  queueComicsForPanelImages: vi.fn(),
}));
vi.mock('~/server/services/rating-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RatingReviewService>()),
  maybeAutoResolveRatingDisputeAfterScan: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  updatePostNsfwLevel: vi.fn(),
  bustCachesForPosts: vi.fn(),
}));
vi.mock('../../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { getWorkflow } = await import('@civitai/orchestration-client');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { postTextScanAdapter } = await import('~/server/services/text-scan/adapters');
const { updatePostNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { updatePostNsfwLevel } = await import('~/server/services/post.service');
const { createNotification } = await import('~/server/services/notification.service');
const { applyIngestionSideEffects } = await import('~/server/services/image-scan-pipeline');

const POST_ID = 7;
const FLOOR = 8;

registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  load: async () => new Map([[POST_ID, { userId: 5, fields: [], declared: { nsfwLevel: 0 } }]]),
});

const metadata = {
  entityType: 'Post',
  entityId: POST_ID,
  emEntityType: 'Post',
  mode: 'active',
  externalId: 'ts-Post-7-abc-0-0',
  labels: ['nsfw'],
  promptIds: { base: 1, nsfw: 2 },
  model: 'air:test',
};
const RAISED = { nsfw: { level: 'x', reason: 'r' } };
const raisedWorkflow = {
  data: {
    metadata,
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

// Mirrors raiseNsfwLevelText in packages/civitai-shared/src/rated-entity-sql.ts.
const recompute = () => {
  const l = post.images;
  const f = verdict?.nsfwLevel ?? 0;
  const raised = l === 0 || f === 0 ? l : (l & ~(f - 1)) === 0 ? f : l & ~(f - 1);
  post.level = post.moderatorNsfwLevel ?? raised;
};
const ratingNotices = () =>
  vi.mocked(createNotification).mock.calls.filter(([n]) => n.type === 'text-scan-rating-raised');

const imageScanned = async (imageLevel: number) => {
  post.images |= imageLevel;
  await applyIngestionSideEffects({
    image: {
      id: 77,
      userId: 5,
      type: 'image',
      metadata: {},
      postId: POST_ID,
      nsfwLevel: imageLevel,
      ingestion: ImageIngestionStatus.Scanned,
    } as never,
    outcome: { ingestion: ImageIngestionStatus.Scanned } as never,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  post = { images: 0, level: 0, moderatorNsfwLevel: null };
  verdict = null;
  vi.mocked(getModerationAdapter).mockReturnValue(postTextScanAdapter);
  vi.mocked(updatePostNsfwLevels).mockImplementation(async () => recompute());
  vi.mocked(updatePostNsfwLevel).mockImplementation(async () => recompute());
  dbMock.dbWrite.post.findUnique.mockImplementation((async () => ({
    nsfwLevel: post.level,
    moderatorNsfwLevel: post.moderatorNsfwLevel,
    userId: 5,
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
        workflowId: data.workflowId ?? 'wf-1',
        nsfwLevel: data.nsfwLevel,
        triggeredLabels: data.triggeredLabels ?? [],
        result: data.result ?? null,
      };
    }
    return { count: 1 };
  }) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation((async () => [{ images: post.images }]) as never);
});

describe('rating-raised notice when the floor lands on the image-scan recompute', () => {
  it('notifies once when the verdict lands before the post has a rating', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(raisedWorkflow as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(post.level).toBe(0);
    expect(ratingNotices()).toHaveLength(0);

    await imageScanned(1);
    await imageScanned(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
    expect(ratingNotices()[0][0]).toMatchObject({
      userId: 5,
      key: `text-scan-rating-raised-Post-${POST_ID}-${FLOOR}-wf-1`,
      details: { level: FLOOR },
    });
  });

  it('does not notify again on the recompute when the callback already did', async () => {
    post.images = 1;
    recompute();
    vi.mocked(getWorkflow).mockResolvedValue(raisedWorkflow as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(ratingNotices()).toHaveLength(1);

    await imageScanned(2);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
  });

  it('does not notify when the images reach the floor on their own', async () => {
    verdict = {
      workflowId: 'wf-1',
      nsfwLevel: FLOOR,
      triggeredLabels: ['nsfw'],
      result: { version: 1 },
    };

    await imageScanned(FLOOR);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('does not notify when the recompute finds a moderator rating', async () => {
    verdict = {
      workflowId: 'wf-1',
      nsfwLevel: FLOOR,
      triggeredLabels: ['nsfw'],
      result: { version: 1 },
    };
    vi.mocked(updatePostNsfwLevel).mockImplementation(async () => {
      post.moderatorNsfwLevel = FLOOR;
      recompute();
    });

    await imageScanned(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it.each(['poi', 'minor'])('does not notify a raise deferred for %s', async (label) => {
    verdict = {
      workflowId: 'wf-1',
      nsfwLevel: FLOOR,
      triggeredLabels: ['nsfw', label],
      result: { version: 1 },
    };

    await imageScanned(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('does not notify a floor at the level the owner declared', async () => {
    verdict = { workflowId: 'wf-1', nsfwLevel: FLOOR, triggeredLabels: [], result: { version: 1 } };

    await imageScanned(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('applies the recompute when the rating read before it fails', async () => {
    verdict = {
      workflowId: 'wf-1',
      nsfwLevel: FLOOR,
      triggeredLabels: ['nsfw'],
      result: { version: 1 },
    };
    dbMock.dbWrite.post.findUnique.mockRejectedValueOnce(new Error('read failed'));

    await imageScanned(1);

    expect(post.level).toBe(FLOOR);
  });

  it('applies the recompute when the notice lookup fails', async () => {
    verdict = {
      workflowId: 'wf-1',
      nsfwLevel: FLOOR,
      triggeredLabels: ['nsfw'],
      result: { version: 1 },
    };
    dbMock.dbWrite.entityModeration.findUnique.mockRejectedValue(new Error('read failed'));

    await imageScanned(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });
});
