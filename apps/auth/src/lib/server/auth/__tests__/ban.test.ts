import { describe, it, expect } from 'vitest';
import { getUserBanDetails } from '../ban';

describe('getUserBanDetails', () => {
  it('returns undefined when there is no ban metadata', () => {
    expect(getUserBanDetails({ meta: undefined })).toBeUndefined();
    expect(getUserBanDetails({ meta: {} })).toBeUndefined();
    expect(getUserBanDetails({ meta: { banDetails: undefined } })).toBeUndefined();
  });

  it('carries the external details and omits the reason code for a non-moderator', () => {
    const r = getUserBanDetails({
      meta: { banDetails: { reasonCode: 'Other', detailsExternal: 'public reason' } },
    });
    expect(r).toEqual({ bannedReasonDetails: 'public reason' });
    expect(r).not.toHaveProperty('banReasonCode');
  });

  it('includes the raw reason code (not a label) for a moderator', () => {
    const r = getUserBanDetails({
      meta: { banDetails: { reasonCode: 'Harassment', detailsExternal: 'x' } },
      isModerator: true,
    });
    expect(r).toEqual({ banReasonCode: 'Harassment', bannedReasonDetails: 'x' });
  });

  it('drops undefined keys', () => {
    const r = getUserBanDetails({ meta: { banDetails: { reasonCode: 'Other' } }, isModerator: true });
    expect(r).toEqual({ banReasonCode: 'Other' });
    expect(r).not.toHaveProperty('bannedReasonDetails');
  });
});
