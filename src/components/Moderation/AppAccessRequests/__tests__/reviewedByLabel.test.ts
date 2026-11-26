import { describe, expect, it } from 'vitest';
import { reviewedByLabel } from '../reviewedByLabel';

describe('reviewedByLabel', () => {
  it('🔴 a SYSTEM decline (a ban by the system account) never reads as an approval', () => {
    expect(
      reviewedByLabel({ status: 'declined', reviewSource: 'system', reviewedByUsername: null })
    ).toBe('Declined automatically');
  });

  it('a system approval reads as automatic', () => {
    expect(
      reviewedByLabel({ status: 'approved', reviewSource: 'system', reviewedByUsername: null })
    ).toBe('Approved automatically');
  });

  it('a moderator decision names the moderator, or "a moderator" once the account is gone', () => {
    expect(
      reviewedByLabel({ status: 'declined', reviewSource: 'moderator', reviewedByUsername: 'kim' })
    ).toBe('kim');
    expect(
      reviewedByLabel({ status: 'approved', reviewSource: 'moderator', reviewedByUsername: null })
    ).toBe('a moderator');
  });
});
