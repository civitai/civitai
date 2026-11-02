import { describe, expect, it, vi } from 'vitest';

const getAwaitingReplyBadge = vi.hoisted(() => vi.fn(async () => 3));
vi.mock('$lib/server/message-as-civitai-count', () => ({ getAwaitingReplyBadge }));

vi.mock('$lib/server/sidebar-counts.service', () => ({
  getSidebarCounts: async () => ({
    counts: { modelFlagsAppeals: 4, strikeReview: 2 },
    unavailable: ['modelFlagsNeedsReview'],
  }),
}));

const { GET } = await import('../+server');

const get = async (user: unknown) =>
  (await GET({ locals: { user } } as unknown as Parameters<typeof GET>[0])).json();

describe('GET /api/sidebar-counts', () => {
  it('sends the counts flat, with the uncounted keys beside them', async () => {
    // Flat, so a tab still running the client from before a deploy reads its numbers.
    expect(await get({ id: 1 })).toEqual({
      modelFlagsAppeals: 4,
      strikeReview: 2,
      civitaiMessages: 3,
      unavailable: ['modelFlagsNeedsReview'],
    });
  });

  it('reads the Civitai Messages count outside the shared fill, and marks it uncounted when it fails', async () => {
    getAwaitingReplyBadge.mockResolvedValueOnce(0);
    expect((await get({ id: 1 })).civitaiMessages).toBe(0);
    getAwaitingReplyBadge.mockRejectedValueOnce(new Error('pool exhausted'));
    const failed = await get({ id: 1 });
    expect(failed.civitaiMessages).toBeUndefined();
    expect(failed.unavailable).toContain('civitaiMessages');
  });

  it('sends nothing without a user', async () => {
    expect(await get(undefined)).toEqual({});
  });

  it('does not hold the sidebar for a Civitai Messages count that never answers', async () => {
    vi.useFakeTimers();
    try {
      getAwaitingReplyBadge.mockImplementationOnce(() => new Promise<number>(() => undefined));
      const pending = get({ id: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).unavailable).toContain('civitaiMessages');
    } finally {
      vi.useRealTimers();
    }
  });
});
