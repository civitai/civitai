import { describe, expect, it } from 'vitest';
import { reviewMuteNotifications } from '~/server/notifications/review-mute.notifications';

describe('review-muted notice', () => {
  const processor = reviewMuteNotifications['review-muted'];

  it('says the account is restricted for the fixed public reason, never the verdict text', () => {
    expect(processor.displayName).toBe('Account restricted');
    const message = processor.prepareMessage({
      type: 'review-muted',
      category: processor.category,
      details: { reason: 'model free text' },
    } as never)?.message;
    expect(message).toContain('Account restricted');
    expect(message).toContain('Impersonating Civitai staff');
    expect(message).not.toContain('model free text');
  });
});
