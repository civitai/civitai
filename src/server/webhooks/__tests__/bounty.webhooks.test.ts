import { describe, expect, it, vi } from 'vitest';
import { bountyWebhooks } from '~/server/webhooks/bounty.webhooks';

describe('new-bounty webhook', () => {
  it('never announces a Private bounty', async () => {
    const findMany = vi.fn(async () => []);
    await bountyWebhooks['new-bounty'].getData({
      lastSent: new Date(0),
      prisma: { bounty: { findMany } },
    } as never);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ availability: { not: 'Private' } }),
      })
    );
  });
});

describe('new-bounty webhook payload', () => {
  it('leaves the profanity fields out of the details', async () => {
    const findMany = vi.fn(async () => [
      {
        id: 1,
        details: {
          baseModel: 'SD 1.5',
          profanityMatches: ['term'],
          profanityEvaluation: { reason: 'test reason' },
        },
        tags: [],
        user: { username: 'u', image: null },
      },
    ]);
    const [payload] = await bountyWebhooks['new-bounty'].getData({
      lastSent: new Date(0),
      prisma: { bounty: { findMany }, imageConnection: { findMany: vi.fn(async () => []) } },
    } as never);
    expect(payload.details).toEqual({ baseModel: 'SD 1.5' });
  });
});
