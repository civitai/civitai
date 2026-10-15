import { describe, expect, it } from 'vitest';
import type { DisputeEvent } from '$lib/server/creator-services-disputes.service';
import { disputeOrigin } from '../origin';

const event = (id: number, reasonCode: string | null): DisputeEvent => ({
  id,
  type: 'Disputed',
  actorId: 7,
  round: null,
  comment: null,
  reasonCode,
  createdAt: '2026-10-15T10:00:00Z',
});

describe('disputeOrigin', () => {
  it('labels the two system holds and shows no text or code for them', () => {
    expect(
      disputeOrigin({ disputeReason: 'seller_unavailable', cancellationReason: null })
    ).toEqual({
      label: 'Seller banned or deleted before payout',
      system: true,
      text: null,
      code: null,
    });
    expect(
      disputeOrigin({
        disputeReason: 'final_scan_failed',
        cancellationReason: null,
        events: [event(1, 'not_as_described')],
      })
    ).toMatchObject({ system: true, text: null, code: null });
  });

  it('shows the requester text of a declined cancellation, not the code', () => {
    expect(
      disputeOrigin({ disputeReason: 'cancellation_declined', cancellationReason: 'too slow' })
    ).toEqual({ label: 'Cancellation declined', system: false, text: 'too slow', code: null });
  });

  it('does not read an inherited property name as a system code', () => {
    expect(disputeOrigin({ disputeReason: 'constructor', cancellationReason: null })).toEqual({
      label: 'Buyer dispute',
      system: false,
      text: 'constructor',
      code: null,
    });
  });

  it('treats anything else as the buyer’s own words, and tolerates absent text', () => {
    expect(
      disputeOrigin({ disputeReason: 'files do not match', cancellationReason: null })
    ).toEqual({
      label: 'Buyer dispute',
      system: false,
      text: 'files do not match',
      code: null,
    });
    expect(disputeOrigin({ disputeReason: null, cancellationReason: null }).text).toBeNull();
  });

  it('falls back to the latest reason code when a party-opened dispute has no text', () => {
    expect(
      disputeOrigin({
        disputeReason: null,
        cancellationReason: null,
        events: [event(1, 'first'), event(2, null), event(3, 'files_missing')],
      })
    ).toMatchObject({ label: 'Buyer dispute', text: null, code: 'files_missing' });
  });

  it('falls back to the code for a declined cancellation whose requester text was dropped', () => {
    expect(
      disputeOrigin({
        disputeReason: 'cancellation_declined',
        cancellationReason: null,
        events: [event(1, 'seller_unresponsive')],
      })
    ).toMatchObject({ label: 'Cancellation declined', text: null, code: 'seller_unresponsive' });
  });

  it('does not show a code when the text is present', () => {
    expect(
      disputeOrigin({
        disputeReason: 'files do not match',
        cancellationReason: null,
        events: [event(1, 'files_missing')],
      }).code
    ).toBeNull();
  });
});
