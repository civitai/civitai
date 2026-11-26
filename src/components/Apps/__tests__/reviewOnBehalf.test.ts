import { describe, expect, it } from 'vitest';
import { reviewOnBehalfLine } from '~/components/Apps/reviewOnBehalf';

/** What the moderator reads on a staff submit made on the owner's behalf, pinned as literals. */
describe('reviewOnBehalfLine', () => {
  const files = { files: [], added: [], removed: [], changed: [] };

  it('names the staff submitter, the owner and the update', () => {
    expect(
      reviewOnBehalfLine({
        ...files,
        onBehalf: {
          platformUpdateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
          staffUserId: 8001,
          staffUsername: 'mod-ana',
          ownerUserId: 7101,
          ownerUsername: 'owner-olga',
        },
      })
    ).toEqual({
      heading: 'Staff submission',
      value: 'submitted by mod-ana for owner-olga (platform update apu_01JABCDEFGHJKMNPQRSTVWXYZ0)',
    });
  });

  it('falls back to the user id when an account has no username', () => {
    expect(
      reviewOnBehalfLine({
        ...files,
        onBehalf: { staffUserId: 8001, staffUsername: null, ownerUserId: 7101, ownerUsername: '' },
      })
    ).toEqual({ heading: 'Staff submission', value: 'submitted by user 8001 for user 7101' });
  });

  it('nothing for an ordinary submit', () => {
    expect(reviewOnBehalfLine(files)).toBeNull();
    expect(reviewOnBehalfLine(null)).toBeNull();
  });
});
