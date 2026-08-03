import { describe, expect, it } from 'vitest';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';
import {
  OFFSITE_REJECTION_REASON_MIN,
  rejectExternalRequestSchema,
} from '~/server/schema/blocks/offsite-listing.schema';
import {
  PUBLISH_REJECTION_REASON_MIN,
  rejectRequestSchema,
} from '~/server/schema/blocks/publish-request.schema';

/**
 * Bug 1: the /apps/review Reject confirm was gated on a silent 10-char minimum
 * while every other moderator-reason field on the page uses the shared 3-char
 * `OFFSITE_MOD_REASON_MIN`. The minimum is now unified across BOTH server reject
 * schemas (off-site + on-site) so the client gate and server validation agree —
 * this test locks that lockstep so a future edit can't silently re-diverge.
 */
describe('reject-reason minimum is unified on OFFSITE_MOD_REASON_MIN (Bug 1)', () => {
  it('both reject-reason floors equal the shared moderator-reason minimum (3)', () => {
    expect(OFFSITE_MOD_REASON_MIN).toBe(3);
    expect(OFFSITE_REJECTION_REASON_MIN).toBe(OFFSITE_MOD_REASON_MIN);
    expect(PUBLISH_REJECTION_REASON_MIN).toBe(OFFSITE_MOD_REASON_MIN);
  });

  it('off-site reject schema accepts a min-length reason and rejects a shorter one', () => {
    const atMin = 'a'.repeat(OFFSITE_MOD_REASON_MIN);
    const tooShort = 'a'.repeat(OFFSITE_MOD_REASON_MIN - 1);
    expect(
      rejectExternalRequestSchema.safeParse({ publishRequestId: 'req-1', rejectionReason: atMin })
        .success
    ).toBe(true);
    expect(
      rejectExternalRequestSchema.safeParse({
        publishRequestId: 'req-1',
        rejectionReason: tooShort,
      }).success
    ).toBe(false);
  });

  it('on-site reject schema accepts a min-length reason and rejects a shorter one', () => {
    const atMin = 'a'.repeat(OFFSITE_MOD_REASON_MIN);
    const tooShort = 'a'.repeat(OFFSITE_MOD_REASON_MIN - 1);
    expect(
      rejectRequestSchema.safeParse({ publishRequestId: 'req-1', rejectionReason: atMin }).success
    ).toBe(true);
    expect(
      rejectRequestSchema.safeParse({ publishRequestId: 'req-1', rejectionReason: tooShort })
        .success
    ).toBe(false);
  });
});
