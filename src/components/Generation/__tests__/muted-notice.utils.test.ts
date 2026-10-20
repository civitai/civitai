import { describe, expect, it } from 'vitest';
import { mutedNoticeVariant } from '~/components/Generation/muted-notice.utils';

describe('mutedNoticeVariant', () => {
  it('sends a two-strike mute to the Terms instead of promising a moderator review', () => {
    expect(mutedNoticeVariant({ mutedAt: null, tosReacceptanceOffered: true })).toBe(
      'accept-terms'
    );
  });

  it('keeps the review copy for a system mute the Terms do not lift', () => {
    expect(mutedNoticeVariant({ mutedAt: null, tosReacceptanceOffered: false })).toBe(
      'pending-review'
    );
  });

  it("never offers the Terms on a moderator's mute", () => {
    expect(mutedNoticeVariant({ mutedAt: new Date(), tosReacceptanceOffered: true })).toBe(
      'upheld'
    );
  });
});
