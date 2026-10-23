import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/sidebar-counts.service', () => ({
  getSidebarCounts: async () => ({
    counts: { modelFlagsAppeals: 4, strikeReview: 2 },
    unavailable: ['modelFlagsNeedsReview'],
  }),
}));

const { GET } = await import('../+server');

const get = (user: unknown) =>
  GET({ locals: { user } } as unknown as Parameters<typeof GET>[0]).then((r) => r.json());

describe('GET /api/sidebar-counts', () => {
  it('sends the counts flat, with the uncounted keys beside them', async () => {
    // Flat, so a tab still running the client from before a deploy reads its numbers.
    expect(await get({ id: 1 })).toEqual({
      modelFlagsAppeals: 4,
      strikeReview: 2,
      unavailable: ['modelFlagsNeedsReview'],
    });
  });

  it('sends nothing without a user', async () => {
    expect(await get(undefined)).toEqual({});
  });
});
