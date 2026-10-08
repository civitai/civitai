import { describe, expect, it } from 'vitest';
import {
  FLAG_ALERT_MESSAGES,
  getMinorFlagAlertState,
  selectModelFlagAlertMessage,
} from '~/components/Model/minor-flag-alert-state';

describe('getMinorFlagAlertState', () => {
  it('offers the button when no appeal exists', () => {
    expect(getMinorFlagAlertState(null)).toEqual({
      showRequestButton: true,
      upheldAt: null,
      copyVariant: 'noAppeal',
    });
  });

  it('withholds the button while an appeal is pending', () => {
    expect(getMinorFlagAlertState({ status: 'Pending', resolvedAt: null })).toEqual({
      showRequestButton: false,
      upheldAt: null,
      copyVariant: 'pending',
    });
  });

  // Seb: "unless they request the review again" — a rejection reopens the path.
  it('reopens the button after a rejection and reports when it was upheld', () => {
    const resolvedAt = new Date('2026-08-12');
    expect(getMinorFlagAlertState({ status: 'Rejected', resolvedAt })).toEqual({
      showRequestButton: true,
      upheldAt: resolvedAt,
      copyVariant: 'rejected',
    });
  });
});

describe('selectModelFlagAlertMessage', () => {
  it('names the minor restriction when both flags are set — it is the stricter one', () => {
    expect(selectModelFlagAlertMessage({ minorFlagged: true, poiFlagged: true })).toBe(
      FLAG_ALERT_MESSAGES.modelMinor
    );
  });

  it('names the real-person restriction for a poi-only flag', () => {
    expect(selectModelFlagAlertMessage({ minorFlagged: false, poiFlagged: true })).toBe(
      FLAG_ALERT_MESSAGES.modelPoi
    );
  });
});
