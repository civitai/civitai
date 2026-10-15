import { describe, expect, it } from 'vitest';
import {
  cancellationCodeOptions,
  cancellationReasonLine,
  declineCodeOptions,
  disputeCodeOptions,
  reasonLabel,
  textActionReady,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import {
  SERVICE_DEAL_CANCELLATION_REASON_CODES,
  SERVICE_DEAL_DECLINE_REASON_CODES,
  SERVICE_DEAL_DISPUTE_REASON_CODES,
} from '~/shared/constants/creator-services.constants';

const values = (options: { value: string }[]) => options.map((option) => option.value);

describe('reason pickers', () => {
  it('offer every decline and dispute code the server takes', () => {
    expect(values(declineCodeOptions)).toEqual([...SERVICE_DEAL_DECLINE_REASON_CODES]);
    expect(values(disputeCodeOptions)).toEqual([...SERVICE_DEAL_DISPUTE_REASON_CODES]);
  });

  it('offer each side only the cancellation reasons it could mean, all of them server codes', () => {
    expect(values(cancellationCodeOptions('buyer'))).toEqual([
      'not_delivered',
      'quality',
      'changed_mind',
      'other',
    ]);
    expect(values(cancellationCodeOptions('seller'))).toEqual([
      'buyer_unresponsive',
      'cannot_complete',
      'other',
    ]);
    for (const role of ['buyer', 'seller'] as const)
      for (const value of values(cancellationCodeOptions(role)))
        expect(SERVICE_DEAL_CANCELLATION_REASON_CODES).toContain(value);
  });
});

// Decision (Creator Services P3): reason codes are optional on every exit, and a required reason
// is met by the text OR a code, so a muted user (no text box) can still leave with a code alone.
describe('when a reason form can be sent', () => {
  it('needs nothing when no reason is required', () => {
    expect(textActionReady({ required: false, text: '', code: null, hasCodes: true })).toBe(true);
  });

  it('takes either the text or a picked code when a reason is required', () => {
    expect(textActionReady({ required: true, text: '', code: null, hasCodes: true })).toBe(false);
    expect(textActionReady({ required: true, text: '', code: 'other', hasCodes: true })).toBe(true);
    expect(textActionReady({ required: true, text: 'late', code: null, hasCodes: true })).toBe(
      true
    );
  });

  it('ignores a stray code when the form has no picker', () => {
    expect(textActionReady({ required: true, text: '', code: 'other', hasCodes: false })).toBe(
      false
    );
  });
});

describe('the reason shown to the other side', () => {
  const event = (type: string, reasonCode: string | null) => ({ type, reasonCode });

  it('uses the latest request code and its text, either alone', () => {
    const events = [
      event('CancellationRequested', 'quality'),
      event('CancellationRequested', 'not_delivered'),
    ];
    expect(cancellationReasonLine({ cancellation: { reason: 'nothing came' }, events })).toBe(
      'Their reason: Not delivered. "nothing came"'
    );
    expect(cancellationReasonLine({ cancellation: { reason: null }, events })).toBe(
      'Their reason: Not delivered.'
    );
    expect(
      cancellationReasonLine({
        cancellation: { reason: 'late' },
        events: [event('Accepted', null)],
      })
    ).toBe('Their reason: "late"');
    expect(cancellationReasonLine({ cancellation: null, events: [] })).toBeUndefined();
  });

  it('shows no label for a code this client does not know', () => {
    expect(reasonLabel('something_new')).toBeNull();
    expect(reasonLabel(null)).toBeNull();
    expect(reasonLabel('too_busy')).toBe('Too busy right now');
  });
});
