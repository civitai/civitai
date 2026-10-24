import { describe, expect, it } from 'vitest';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

const render = (details: Record<string, unknown>) =>
  notificationProcessors['text-scan-rating-raised'].prepareMessage({ details } as never);

describe('text-scan-rating-raised', () => {
  it('is registered, not toggleable, and links to the entity', () => {
    expect(notificationProcessors['text-scan-rating-raised'].toggleable).toBe(false);
    expect(
      render({ entityType: 'Post', entityId: 7, level: 4, title: 'Beach day', url: '/posts/7' })
    ).toEqual({
      message:
        'Your post "Beach day" is now rated R based on its text. If you believe this is a mistake, you can dispute the rating on its page.',
      url: '/posts/7',
    });
  });

  it('omits a missing title', () => {
    expect(
      render({
        entityType: 'BountyEntry',
        entityId: 7,
        level: 8,
        title: null,
        url: '/bounties/3/entries/7',
      })?.message
    ).toBe(
      'Your bounty entry is now rated X based on its text. If you believe this is a mistake, you can dispute the rating on its page.'
    );
  });
});

describe('textScanRatingRaisedKey', () => {
  it('is per workflow, so a later raise to the same level after a dispute still reaches the owner', async () => {
    const { textScanRatingRaisedKey } = await import('~/server/services/text-scan/notify');
    expect(
      textScanRatingRaisedKey({ entityType: 'Post', entityId: 7, level: 4, workflowId: 'wf-1' })
    ).toBe('text-scan-rating-raised-Post-7-4-wf-1');
  });
});
