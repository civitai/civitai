import { describe, expect, it, vi } from 'vitest';

const countAwaitingReply = vi.hoisted(() => vi.fn(async () => 3));
vi.mock('$lib/server/message-as-civitai-count', () => ({ countAwaitingReply }));

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

  it('reads the Civitai Messages count on every request, and marks it uncounted when it fails', async () => {
    countAwaitingReply.mockResolvedValueOnce(0);
    expect((await get({ id: 1 })).civitaiMessages).toBe(0);
    countAwaitingReply.mockRejectedValueOnce(new Error('pool exhausted'));
    const failed = await get({ id: 1 });
    expect(failed.civitaiMessages).toBeUndefined();
    expect(failed.unavailable).toContain('civitaiMessages');
  });

  it('sends nothing without a user', async () => {
    expect(await get(undefined)).toEqual({});
  });
});
