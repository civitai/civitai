import { describe, expect, it } from 'vitest';
import { getMinorFlagAlertState } from '~/components/Model/minor-flag-alert-state';

describe('getMinorFlagAlertState', () => {
  it('offers the button when no appeal exists', () => {
    expect(getMinorFlagAlertState(null)).toEqual({
      tone: 'red',
      showRequestButton: true,
      upheldAt: null,
    });
  });

  it('withholds the button while an appeal is pending', () => {
    expect(getMinorFlagAlertState({ status: 'Pending', resolvedAt: null })).toEqual({
      tone: 'yellow',
      showRequestButton: false,
      upheldAt: null,
    });
  });

  // Seb: "unless they request the review again" — a rejection reopens the path.
  it('reopens the button after a rejection and reports when it was upheld', () => {
    const resolvedAt = new Date('2026-08-12');
    expect(getMinorFlagAlertState({ status: 'Rejected', resolvedAt })).toEqual({
      tone: 'red',
      showRequestButton: true,
      upheldAt: resolvedAt,
    });
  });
});
