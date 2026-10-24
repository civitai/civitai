import { describe, expect, it } from 'vitest';
import {
  cancellationCodeOptions,
  cancellationReasonLine,
  cancellationSide,
  declineCodeOptions,
  disputeCodeOptions,
  exitInputs,
  reasonFormLabels,
  reasonFormValues,
  reasonLabel,
  textActionReady,
} from '~/components/CreatorShop/Services/deals/deal-ui';
import { SERVICE_DEAL_CANCELLATION_REASON_CODES } from '~/shared/constants/creator-services.constants';

const values = (options: { value: string }[]) => options.map((option) => option.value);

describe('reason pickers', () => {
  it('offer the agreed decline and dispute reasons, labelled', () => {
    expect(declineCodeOptions).toEqual([
      { value: 'too_busy', label: 'Too busy right now' },
      { value: 'out_of_scope', label: 'Outside what I offer' },
      { value: 'price_or_terms', label: 'Price or terms' },
      { value: 'other', label: 'Other' },
    ]);
    expect(values(disputeCodeOptions)).toEqual([
      'files_missing_or_broken',
      'not_as_previewed',
      'other',
    ]);
  });

  it('gives sellers the seller list and everyone else the buyer list', () => {
    expect(cancellationSide('seller')).toBe('seller');
    expect(cancellationSide('buyer')).toBe('buyer');
    expect(cancellationSide('moderator')).toBe('buyer');
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
    expect(reasonLabel('constructor')).toBeNull();
    expect(reasonLabel(null)).toBeNull();
    expect(reasonLabel('too_busy')).toBe('Too busy right now');
  });
});

describe('what a reason form sends', () => {
  it("never sends a muted viewer's text, and leaves empty values out", () => {
    expect(reasonFormValues({ muted: true, text: 'typed before the mute', code: 'other' })).toEqual(
      {
        text: undefined,
        code: 'other',
      }
    );
    expect(reasonFormValues({ muted: false, text: '  late  ', code: null })).toEqual({
      text: 'late',
      code: undefined,
    });
    expect(reasonFormValues({ muted: false, text: '   ', code: null })).toEqual({
      text: undefined,
      code: undefined,
    });
  });

  it("sends each exit its own fields, and drops a code from another action's list", () => {
    expect(exitInputs.decline(7, 'busy', 'too_busy')).toEqual({
      id: 7,
      reason: 'busy',
      reasonCode: 'too_busy',
    });
    expect(exitInputs.requestCancellation(7, undefined, 'quality')).toEqual({
      id: 7,
      reason: undefined,
      reasonCode: 'quality',
    });
    expect(exitInputs.openDispute(7, 'x', 'not_as_previewed').reasonCode).toBe('not_as_previewed');
    expect(exitInputs.openDispute(7, 'x', 'quality').reasonCode).toBeUndefined();
    expect(exitInputs.decline(7, undefined, 'not_delivered').reasonCode).toBeUndefined();
  });

  it('stars a field only when it is the one way to meet a required reason', () => {
    // Either the picker or the text meets it, so neither is starred; the hint says so.
    expect(reasonFormLabels({ required: true, hasCodes: true, muted: false })).toMatchObject({
      codeRequired: false,
      hint: 'Pick a reason, add details, or both.',
      codeClearable: true,
      textRequired: false,
      textLabel: 'Details (optional if you picked a reason)',
    });
    expect(reasonFormLabels({ required: true, hasCodes: true, muted: true })).toMatchObject({
      codeRequired: true,
      codeClearable: false,
    });
    expect(reasonFormLabels({ required: true, hasCodes: false, muted: false })).toMatchObject({
      codeRequired: false,
      textRequired: true,
      textLabel: 'Reason',
    });
    expect(reasonFormLabels({ required: false, hasCodes: true, muted: false })).toMatchObject({
      codeRequired: false,
      textRequired: false,
      textLabel: 'Comment (optional)',
    });
  });
});
