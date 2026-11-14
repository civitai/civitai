import { describe, expect, it } from 'vitest';
import {
  getMembershipHistoryState,
  getMembershipPaymentMethod,
  summarizePrepaidTokens,
} from '~/shared/utils/membership-history';

const now = new Date('2026-10-21T00:00:00Z');
const base = {
  status: 'active',
  paymentMethod: 'card' as const,
  cancelAt: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  endedAt: null,
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
};

describe('getMembershipPaymentMethod', () => {
  it('tells the kinds of membership apart', () => {
    const civitai = { provider: 'Civitai', productMetadata: {}, metadata: {} };
    expect(getMembershipPaymentMethod({ ...civitai, slot: 'yellow' })).toBe('prepaid');
    expect(getMembershipPaymentMethod({ ...civitai, slot: 'buzzPurchase' })).toBe('buzz');
    expect(getMembershipPaymentMethod({ ...civitai, slot: 'referral' })).toBe('referral');
    expect(
      getMembershipPaymentMethod({
        slot: 'green',
        provider: 'Stripe',
        productMetadata: {},
        metadata: { membershipGift: 'true' },
      })
    ).toBe('gift');
    expect(
      getMembershipPaymentMethod({
        slot: 'green',
        provider: 'Stripe',
        productMetadata: {},
        metadata: {},
      })
    ).toBe('card');
    expect(
      getMembershipPaymentMethod({
        ...civitai,
        slot: 'yellow',
        metadata: { source: 'referral-redemption' },
      })
    ).toBe('referral');
    expect(
      getMembershipPaymentMethod({
        ...civitai,
        slot: 'yellow',
        productMetadata: { buzzPurchase: 'true' },
      })
    ).toBe('buzz');
  });
});

describe('getMembershipHistoryState', () => {
  it('reports a canceled prepaid membership as ended when it was canceled', () => {
    // A prepaid membership whose period ran out and was canceled by the expiry job.
    expect(
      getMembershipHistoryState(
        {
          ...base,
          paymentMethod: 'prepaid',
          status: 'canceled',
          cancelAtPeriodEnd: true,
          canceledAt: new Date('2026-10-13T05:00:15Z'),
          currentPeriodEnd: new Date('2026-10-13T05:00:00Z'),
        },
        now
      )
    ).toEqual({
      state: 'ended',
      date: new Date('2026-10-13T05:00:15Z'),
      reason: 'The prepaid period ran out',
    });
  });

  it('treats a non-renewing membership past its end as ended before the row is updated', () => {
    const state = getMembershipHistoryState(
      { ...base, paymentMethod: 'prepaid', currentPeriodEnd: new Date('2026-10-13T05:00:00Z') },
      now
    );
    expect(state.state).toBe('ended');
  });

  it('says when an active membership ends or renews', () => {
    expect(getMembershipHistoryState(base, now)).toEqual({
      state: 'renews',
      date: base.currentPeriodEnd,
    });
    expect(getMembershipHistoryState({ ...base, paymentMethod: 'prepaid' }, now)).toEqual({
      state: 'ends',
      date: base.currentPeriodEnd,
    });
    const cancelAt = new Date('2026-12-01T00:00:00Z');
    expect(getMembershipHistoryState({ ...base, paymentMethod: 'gift', cancelAt }, now)).toEqual({
      state: 'ends',
      date: cancelAt,
    });
  });

  it('says a canceled card membership ends instead of renewing', () => {
    expect(getMembershipHistoryState({ ...base, cancelAtPeriodEnd: true }, now)).toEqual({
      state: 'ends',
      date: base.currentPeriodEnd,
    });
    const cancelAt = new Date('2026-10-25T00:00:00Z');
    expect(getMembershipHistoryState({ ...base, cancelAt }, now)).toEqual({
      state: 'ends',
      date: cancelAt,
    });
  });

  it('explains a first payment that never went through', () => {
    expect(getMembershipHistoryState({ ...base, status: 'incomplete_expired' }, now)).toMatchObject(
      { state: 'ended', reason: 'The first payment never went through' }
    );
  });

  it('flags failed payments', () => {
    expect(getMembershipHistoryState({ ...base, status: 'past_due' }, now).state).toBe(
      'payment-failed'
    );
  });

  it('explains a Buzz membership replaced by a paid one', () => {
    const state = getMembershipHistoryState(
      {
        ...base,
        paymentMethod: 'buzz',
        status: 'canceled',
        endedAt: new Date('2026-10-15T00:00:00Z'),
      },
      now
    );
    expect(state).toMatchObject({ state: 'ended', reason: 'Replaced by a paid membership' });
  });

  it('explains a membership the history closed because the slot moved on', () => {
    const closed = { ...base, status: 'canceled', endedAt: new Date('2026-10-10T00:00:00Z') };
    expect(getMembershipHistoryState({ ...closed, closedReason: 'replaced' }, now)).toEqual({
      state: 'ended',
      date: closed.endedAt,
      reason: 'Replaced by a new subscription',
    });
    expect(
      getMembershipHistoryState({ ...closed, closedReason: 'plan-changed' }, now)
    ).toMatchObject({ reason: 'Changed to a different plan' });
  });

  it('says a Buzz month that ran its course simply ran out', () => {
    const state = getMembershipHistoryState(
      {
        ...base,
        paymentMethod: 'buzz',
        status: 'canceled',
        endedAt: base.currentPeriodEnd,
      },
      now
    );
    expect(state).toMatchObject({ state: 'ended', reason: 'The month bought with Buzz ran out' });
  });
});

describe('summarizePrepaidTokens', () => {
  it('counts tokens by status', () => {
    const token = { tier: 'gold' as const, buzzAmount: 50000 };
    expect(
      summarizePrepaidTokens([
        { ...token, id: 'a', status: 'claimed' },
        { ...token, id: 'b', status: 'unlocked' },
        { ...token, id: 'c', status: 'locked' },
        { ...token, id: 'd', status: 'locked' },
      ])
    ).toEqual({ total: 4, claimed: 1, readyToClaim: 1, upcoming: 2 });
    expect(summarizePrepaidTokens([])).toBeNull();
  });
});
