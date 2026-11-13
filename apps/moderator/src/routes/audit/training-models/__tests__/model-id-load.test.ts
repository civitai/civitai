import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTrainingModelsFeed } = vi.hoisted(() => ({ getTrainingModelsFeed: vi.fn() }));

vi.mock('$lib/server/training-moderation.service', () => ({
  ANNOUNCEMENT_COLORS: ['blue'],
  getTrainingModelsFeed,
  getTrainingAnnouncement: vi.fn(async () => null),
  getModelOwner: vi.fn(),
  setTrainingAnnouncement: vi.fn(),
  toggleCannotPublish: vi.fn(),
}));
vi.mock('$lib/server/user-actions.service', () => ({ setBanned: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { load } = await import('../+page.server');

const run = (qs: string) =>
  (load as unknown as (e: unknown) => Promise<{ filters: { modelId: string } }>)({
    url: new URL(`https://moderator.example/audit/training-models${qs}`),
  });

beforeEach(() => {
  getTrainingModelsFeed.mockReset();
  getTrainingModelsFeed.mockResolvedValue({ items: [] });
});

describe('training audit load: modelId', () => {
  it('passes a model id through to the feed', async () => {
    await run('?modelId=4821');
    expect(getTrainingModelsFeed.mock.calls[0][0].modelId).toBe(4821);
  });

  it('does not filter when the param is absent', async () => {
    await run('');
    expect(getTrainingModelsFeed.mock.calls[0][0].modelId).toBeUndefined();
  });

  it.each(['123456789012345678901', 'abc', '-5', '99999999999'])(
    'matches no model for an unusable id %j, never the whole feed',
    async (id) => {
      await run(`?modelId=${id}`);
      expect(getTrainingModelsFeed.mock.calls[0][0].modelId).toBe(0);
    }
  );
});
