import { describe, expect, it } from 'vitest';
import {
  isWithdrawableOffsiteStatus,
  offsiteStatusChip,
} from '../offsiteSubmissionStatus';

/**
 * W13 P3a — my-submissions status → chip mapping. Pins the color/label for every
 * request status + the graceful unknown-status fallback + the withdrawable gate.
 */

describe('offsiteStatusChip', () => {
  it('maps all four request statuses', () => {
    expect(offsiteStatusChip('pending')).toEqual({ color: 'blue', label: 'pending' });
    expect(offsiteStatusChip('approved')).toEqual({ color: 'green', label: 'approved' });
    expect(offsiteStatusChip('rejected')).toEqual({ color: 'red', label: 'rejected' });
    expect(offsiteStatusChip('withdrawn')).toEqual({ color: 'gray', label: 'withdrawn' });
  });

  it('falls back to a neutral gray chip with the raw value for an unknown status', () => {
    expect(offsiteStatusChip('archived')).toEqual({ color: 'gray', label: 'archived' });
  });
});

describe('isWithdrawableOffsiteStatus', () => {
  it('only pending is withdrawable', () => {
    expect(isWithdrawableOffsiteStatus('pending')).toBe(true);
    for (const s of ['approved', 'rejected', 'withdrawn', 'weird']) {
      expect(isWithdrawableOffsiteStatus(s)).toBe(false);
    }
  });
});
