import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as Adapters from '~/server/services/moderation-adapters';
import type * as RatingReviewService from '~/server/services/rating-review.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The real callback, Post adapter and rating floor, with the stored Post level held in `stored`.
// Any recompute of the post, the floor's own or another path's, applies the verdict on the row.

// @civitai/orchestration-client is mocked globally in src/__tests__/setup.ts (getWorkflow is a vi.fn()).
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
}));
vi.mock('~/server/services/rating-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RatingReviewService>()),
  maybeAutoResolveRatingDisputeAfterScan: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { getWorkflow } = await import('@civitai/orchestration-client');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { postTextScanAdapter } = await import('~/server/services/text-scan/adapters');
const { updatePostNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { createNotification } = await import('~/server/services/notification.service');

registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  load: async () => new Map([[7, { userId: 5, fields: [], declared: { nsfwLevel: 1 } }]]),
});

const FLOOR = 8;
const metadata = {
  entityType: 'Post',
  entityId: 7,
  emEntityType: 'Post',
  mode: 'active',
  externalId: 'ts-Post-7-abc-0-0',
  labels: ['nsfw'],
  promptIds: { base: 1, nsfw: 2 },
  model: 'air:test',
};
const step = (parsed: unknown, segment = 0) => ({
  $type: 'chatCompletion',
  name: segment ? `textScan${segment}` : 'textScan',
  metadata: { segment },
  output:
    parsed === 'TRUNCATED'
      ? { choices: [{ message: { content: '{"nsfw":' }, finishReason: 'length' }] }
      : {
          choices: [{ message: { content: JSON.stringify(parsed) }, finishReason: 'stop' }],
          parsed,
        },
});
const RAISED = { nsfw: { level: 'x', reason: 'r' } };

let stored: { level: number; floor: number };
const recompute = () => {
  stored.level = Math.max(stored.level, stored.floor);
};
const ratingNotices = () =>
  vi.mocked(createNotification).mock.calls.filter(([n]) => n.type === 'text-scan-rating-raised');

beforeEach(() => {
  vi.clearAllMocks();
  stored = { level: 1, floor: 0 };
  vi.mocked(getModerationAdapter).mockReturnValue(postTextScanAdapter);
  vi.mocked(updatePostNsfwLevels).mockImplementation(async () => {
    recompute();
    return [];
  });
  dbMock.dbWrite.post.findUnique.mockImplementation((async () => ({
    nsfwLevel: stored.level,
    moderatorNsfwLevel: null,
    userId: 5,
    title: 'T',
  })) as never);
  // The verdict write, followed at once by another path's recompute of the post.
  dbMock.dbWrite.entityModeration.updateMany.mockImplementation((async ({
    data,
  }: {
    data: { nsfwLevel?: number | null };
  }) => {
    if (data.nsfwLevel) {
      stored.floor = data.nsfwLevel;
      recompute();
    }
    return { count: 1 };
  }) as never);
});

describe('rating-raised notice when another recompute lands between the verdict write and apply', () => {
  it('sends exactly one notice', async () => {
    vi.mocked(getWorkflow).mockResolvedValue({
      data: { metadata, tags: ['text-scan'], steps: [step(RAISED)] },
    } as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(stored.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
    expect(ratingNotices()[0][0]).toMatchObject({ userId: 5, details: { level: FLOOR } });
  });

  it('sends no second notice when the callback is redelivered', async () => {
    vi.mocked(getWorkflow).mockResolvedValue({
      data: { metadata, tags: ['text-scan'], steps: [step(RAISED)] },
    } as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(updatePostNsfwLevels).toHaveBeenCalledTimes(2);
    expect(ratingNotices()).toHaveLength(1);
  });

  it('sends no notice when the post was already at the floor before the verdict', async () => {
    stored.level = FLOOR;
    vi.mocked(getWorkflow).mockResolvedValue({
      data: { metadata, tags: ['text-scan'], steps: [step(RAISED)] },
    } as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(updatePostNsfwLevels).toHaveBeenCalled();
    expect(ratingNotices()).toHaveLength(0);
  });

  it('records and applies the verdict when the snapshot read fails', async () => {
    dbMock.dbWrite.post.findUnique.mockRejectedValueOnce(new Error('read failed'));
    vi.mocked(getWorkflow).mockResolvedValue({
      data: { metadata, tags: ['text-scan'], steps: [step(RAISED)] },
    } as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(stored.level).toBe(FLOOR);
    expect(updatePostNsfwLevels).toHaveBeenCalled();
  });

  it('sends exactly one notice for a partial verdict raised from the parsed segments', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      workflowId: 'wf-1',
      nsfwLevel: 1,
      triggeredLabels: [],
      result: { version: 1, labels: { nsfw: { level: 'none', reason: 'c' } } },
    } as never);
    vi.mocked(getWorkflow).mockResolvedValue({
      data: {
        metadata: { ...metadata, segments: 2 },
        tags: ['text-scan'],
        steps: [step(RAISED), step('TRUNCATED', 1)],
      },
    } as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(stored.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
  });
});
