import { describe, expect, it } from 'vitest';
import { disputeOrigin } from '../origin';

describe('disputeOrigin', () => {
  it('labels the two system holds and shows no text for them', () => {
    expect(
      disputeOrigin({ disputeReason: 'seller_unavailable', cancellationReason: null })
    ).toEqual({
      label: 'Seller banned or deleted before payout',
      system: true,
      text: null,
    });
    expect(
      disputeOrigin({ disputeReason: 'final_scan_failed', cancellationReason: null })
    ).toMatchObject({
      system: true,
      text: null,
    });
  });

  it('shows the requester text of a declined cancellation, not the code', () => {
    expect(
      disputeOrigin({ disputeReason: 'cancellation_declined', cancellationReason: 'too slow' })
    ).toEqual({ label: 'Cancellation declined', system: false, text: 'too slow' });
  });

  it('does not read an inherited property name as a system code', () => {
    expect(disputeOrigin({ disputeReason: 'constructor', cancellationReason: null })).toEqual({
      label: 'Buyer dispute',
      system: false,
      text: 'constructor',
    });
  });

  it('treats anything else as the buyer’s own words, and tolerates absent text', () => {
    expect(
      disputeOrigin({ disputeReason: 'files do not match', cancellationReason: null })
    ).toEqual({
      label: 'Buyer dispute',
      system: false,
      text: 'files do not match',
    });
    expect(disputeOrigin({ disputeReason: null, cancellationReason: null }).text).toBeNull();
  });
});
