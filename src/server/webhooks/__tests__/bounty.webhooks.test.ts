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
