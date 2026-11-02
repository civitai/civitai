import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A ban, an upheld restriction or a confirmed mute schedules the member's Stripe subscription to
 * cancel at period end; lifting the ban or overturning the restriction reverses it. Only OUR
 * cancellation may be reversed: a member who cancelled on their own must stay cancelled, or the
 * next renewal bills them against their own decision.
 */

type FakeSub = {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  cancellation_details: { comment: string | null; reason: string | null } | null;
};

const { subs, retrieve, update, PERIOD_END } = vi.hoisted(() => {
  const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 86_400;
  const subs = new Map<string, FakeSub>();
  return {
    PERIOD_END,
    subs,
    retrieve: vi.fn(async (id: string) => {
      const sub = subs.get(id);
      if (!sub) throw new Error(`No such subscription: ${id}`);
      return structuredClone(sub);
    }),
    // Mirrors Stripe for the fields under test: setting cancel_at_period_end also sets cancel_at
    // and records the cancellation with whatever comment came with it; clearing it clears both.
    update: vi.fn(
      async (
        id: string,
        params: { cancel_at_period_end?: boolean; cancellation_details?: { comment?: string } }
      ) => {
        const sub = subs.get(id)!;
        if (params.cancel_at_period_end === true) {
          sub.cancel_at_period_end = true;
          sub.cancel_at = PERIOD_END;
          sub.cancellation_details = {
            comment: params.cancellation_details?.comment ?? null,
            reason: 'cancellation_requested',
          };
        } else if (params.cancel_at_period_end === false) {
          sub.cancel_at_period_end = false;
          sub.cancel_at = null;
          sub.cancellation_details = { comment: null, reason: null };
        }
        return structuredClone(sub);
      }
    ),
  };
});

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: async () => ({ subscriptions: { retrieve, update } }),
}));

import { cancelSubscription, reinstateSubscription } from '~/server/services/stripe.service';

const USER_ID = 42;
const SUB_ID = 'sub_123';

const account = { bannedAt: null as Date | null, muted: false };

/** Our row mirrors Stripe's flag, as the subscription webhook keeps it. */
const syncRow = () => {
  const sub = subs.get(SUB_ID);
  dbMock.dbWrite.customerSubscription.findFirst.mockImplementation((async (args: {
    where: { cancelAtPeriodEnd?: boolean };
  }) => {
    if (!sub) return null;
    if (args.where.cancelAtPeriodEnd && !sub.cancel_at_period_end) return null;
    return { id: sub.id };
  }) as never);
};

const activeSub = (overrides: Partial<FakeSub> = {}) => {
  subs.set(SUB_ID, {
    id: SUB_ID,
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    cancellation_details: null,
    ...overrides,
  });
  syncRow();
};

/** What the Stripe billing portal leaves behind when the member cancels and answers its survey. */
const memberCancels = () => {
  const sub = subs.get(SUB_ID)!;
  sub.cancel_at_period_end = true;
  sub.cancel_at = PERIOD_END;
  sub.cancellation_details = { comment: 'too expensive', reason: 'cancellation_requested' };
};

const resumed = () => subs.get(SUB_ID)!.cancel_at_period_end === false;

beforeEach(() => {
  vi.clearAllMocks();
  subs.clear();
  account.bannedAt = null;
  account.muted = false;
  dbMock.dbWrite.user.findUnique.mockImplementation((async () => ({ ...account })) as never);
});

describe('moderation cancel, then reinstate', () => {
  it('resumes a subscription the moderation flow cancelled', async () => {
    activeSub();

    account.bannedAt = new Date();
    await cancelSubscription({ userId: USER_ID, atPeriodEnd: true });
    expect(subs.get(SUB_ID)!.cancel_at_period_end).toBe(true);

    account.bannedAt = null;
    await reinstateSubscription({ userId: USER_ID });

    expect(resumed()).toBe(true);
  });

  it('leaves a member-cancelled subscription cancelled through a ban and its lifting', async () => {
    activeSub();
    memberCancels();

    account.bannedAt = new Date();
    await cancelSubscription({ userId: USER_ID, atPeriodEnd: true });
    account.bannedAt = null;
    await reinstateSubscription({ userId: USER_ID });

    expect(resumed()).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves a member-cancelled subscription cancelled when a restriction is overturned', async () => {
    // An overturn reverses a Pending case, which never cancelled anything itself.
    activeSub();
    memberCancels();

    await reinstateSubscription({ userId: USER_ID });

    expect(resumed()).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not resume an unstamped cancellation (made before the stamp existed)', async () => {
    activeSub({
      cancel_at_period_end: true,
      cancellation_details: { comment: null, reason: 'cancellation_requested' },
    });

    await reinstateSubscription({ userId: USER_ID });

    expect(update).not.toHaveBeenCalled();
  });
});

describe('reinstateSubscription reads Stripe, not our row', () => {
  it('resumes a stamped cancel our row has not caught up with yet', async () => {
    activeSub();
    await cancelSubscription({ userId: USER_ID, atPeriodEnd: true });
    // The webhook that copies cancel_at_period_end onto our row has not landed.
    dbMock.dbWrite.customerSubscription.findFirst.mockImplementation((async (args: {
      where: { cancelAtPeriodEnd?: boolean };
    }) => (args.where.cancelAtPeriodEnd ? null : { id: SUB_ID })) as never);

    await reinstateSubscription({ userId: USER_ID });

    expect(resumed()).toBe(true);
  });
});

describe('reinstateSubscription guards', () => {
  const stampedCancel = async () => {
    activeSub();
    await cancelSubscription({ userId: USER_ID, atPeriodEnd: true });
    update.mockClear();
  };

  it('does not resume while the account is still banned', async () => {
    await stampedCancel();
    account.bannedAt = new Date();

    await reinstateSubscription({ userId: USER_ID });

    expect(update).not.toHaveBeenCalled();
  });

  it('does not resume while the account is still muted', async () => {
    await stampedCancel();
    account.muted = true;

    await reinstateSubscription({ userId: USER_ID });

    expect(update).not.toHaveBeenCalled();
  });

  it('fails closed when Stripe cannot be read', async () => {
    await stampedCancel();
    retrieve.mockRejectedValueOnce(new Error('stripe down'));

    await expect(reinstateSubscription({ userId: USER_ID })).rejects.toThrow('stripe down');

    expect(update).not.toHaveBeenCalled();
  });
});

describe('cancelSubscription({ atPeriodEnd })', () => {
  it('stamps the cancellation it writes', async () => {
    activeSub();

    await cancelSubscription({ userId: USER_ID, atPeriodEnd: true });

    expect(update).toHaveBeenCalledTimes(1);
    expect(subs.get(SUB_ID)!.cancellation_details?.comment).toBeTruthy();
  });

  it('writes nothing over a cancellation the member already scheduled', async () => {
    activeSub();
    memberCancels();

    await cancelSubscription({ userId: USER_ID, atPeriodEnd: true });

    expect(update).not.toHaveBeenCalled();
    expect(subs.get(SUB_ID)!.cancellation_details?.comment).toBe('too expensive');
  });

  it('writes nothing over a gift subscription that already ends on cancel_at', async () => {
    activeSub({ cancel_at: Math.floor(Date.now() / 1000) + 86_400 });

    await cancelSubscription({ userId: USER_ID, atPeriodEnd: true });

    expect(update).not.toHaveBeenCalled();
  });
});
