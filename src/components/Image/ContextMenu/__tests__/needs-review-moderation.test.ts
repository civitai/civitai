import { beforeEach, describe, expect, it, vi } from 'vitest';
import { needsReviewModeration } from '~/components/Image/ContextMenu/needsReviewModeration';
import { imageStore } from '~/store/image.store';

const REFUSAL = 'An image in this batch is withheld from you. Nothing was changed: 1.';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(imageStore, 'setImage');
});

// The moderator app refuses an image withheld from this moderator: the badge must say so, and must
// not mark the image moderated.
describe('NeedsReviewBadge moderation', () => {
  it('shows the refusal and leaves the image as it was', () => {
    const notify = vi.fn();
    needsReviewModeration(1, notify).onError({ message: REFUSAL });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0].error.message).toBe(REFUSAL);
    expect(imageStore.setImage).not.toHaveBeenCalled();
  });

  it('marks the image moderated once the moderation lands', () => {
    const notify = vi.fn();
    needsReviewModeration(1, notify).onSuccess();
    expect(notify).not.toHaveBeenCalled();
    expect(imageStore.setImage).toHaveBeenCalledExactlyOnceWith(1, {
      needsReview: null,
      ingestion: 'Scanned',
    });
  });
});
