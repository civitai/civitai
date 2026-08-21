import { describe, expect, it } from 'vitest';
import { pendingCount } from '~/components/Placement/queue-counts';

describe('pendingCount', () => {
  it('counts only what is still waiting on someone', () => {
    // The positive control and the case together: a count that ignored `status`
    // would be 3 here, and 3 is also what an approved-inclusive badge shows.
    expect(
      pendingCount([{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }])
    ).toBe(2);
  });

  it('is zero when everything has been answered', () => {
    expect(pendingCount([{ status: 'approved' }, { status: 'approved' }])).toBe(0);
  });

  it('is zero for an empty list', () => {
    expect(pendingCount([])).toBe(0);
  });
});
