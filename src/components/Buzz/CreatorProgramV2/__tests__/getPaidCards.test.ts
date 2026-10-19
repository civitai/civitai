import { describe, expect, it } from 'vitest';
import { getPaidCards } from '~/components/Buzz/CreatorProgramV2/getPaidCards';

describe('getPaidCards', () => {
  it.each(['bank', 'extraction'])(
    'shows a lapsed member their banked balance and the withdraw card (phase %s)',
    (phase) => {
      const cards = getPaidCards({ phase, membershipLapsed: true });

      expect(cards).toContain('estimatedEarnings');
      expect(cards).toContain('withdraw');
    }
  );

  it('shows a lapsed member with no phase their banked balance and the withdraw card', () => {
    expect(getPaidCards({ phase: undefined, membershipLapsed: true })).toEqual([
      'estimatedEarnings',
      'withdraw',
    ]);
  });

  it('shows an active member with no phase their banked balance and the withdraw card', () => {
    expect(getPaidCards({ phase: undefined, membershipLapsed: false })).toEqual([
      'estimatedEarnings',
      'withdraw',
    ]);
  });

  it('does not offer a lapsed member banking more Buzz', () => {
    expect(getPaidCards({ phase: 'bank', membershipLapsed: true })).toEqual([
      'estimatedEarnings',
      'withdraw',
    ]);
  });

  it('keeps extraction for a lapsed member during the extraction phase', () => {
    expect(getPaidCards({ phase: 'extraction', membershipLapsed: true })).toEqual([
      'extract',
      'estimatedEarnings',
      'withdraw',
    ]);
  });

  it('leaves an active member’s cards as they were', () => {
    expect(getPaidCards({ phase: 'bank', membershipLapsed: false })).toEqual([
      'bank',
      'estimatedEarnings',
      'withdraw',
    ]);
    expect(getPaidCards({ phase: 'extraction', membershipLapsed: false })).toEqual([
      'extract',
      'estimatedEarnings',
      'withdraw',
    ]);
  });
});
