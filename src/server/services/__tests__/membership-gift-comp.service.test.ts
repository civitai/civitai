import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Comped membership gifts: every refusal is paired with the valid call that writes, so a refusal
 * cannot pass because nothing ever writes. The gift row and its ModActivity row must share the
 * transaction client, since the daily cap counts ModActivity.
 */

const db = dbMock.dbWrite;

const {
  trackModActivity,
  fulfillMembershipGift,
  getRecipientGiftability,
  revokeMembershipGift,
  throwOnBlockedUserContent,
} = vi.hoisted(() => ({
  throwOnBlockedUserContent: vi.fn(async (_text: string, _opts: unknown) => undefined),
  trackModActivity: vi.fn(async () => undefined),
  fulfillMembershipGift: vi.fn(),
  getRecipientGiftability: vi.fn(),
  revokeMembershipGift: vi.fn(async () => true),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/server/services/membership-gift.service', () => ({
  fulfillMembershipGift,
  getRecipientGiftability,
  revokeMembershipGift,
}));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedUserContent }));
import {
  compMembershipGift,
  revokeCompMembershipGift,
} from '~/server/services/membership-gift-comp.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const MODERATOR = 990000007;
const RECIPIENT = 990100021;

const valid = (over: Record<string, unknown> = {}) => ({
  recipientId: RECIPIENT,
  tier: 'gold' as const,
  months: 3,
  reason: 'Thank-you for community work',
  execute: true,
  moderatorId: MODERATOR,
  ...over,
});

const liveUser = (over: Record<string, unknown> = {}) => ({
  id: RECIPIENT,
  username: 'recipient',
  deletedAt: null,
  bannedAt: null,
  muted: false,
  ...over,
});

let order: string[];
// A tx distinct from dbWrite, so a write that skips the transaction client is visible.
let tx: {
  $executeRaw: ReturnType<typeof vi.fn>;
  modActivity: { count: ReturnType<typeof vi.fn> };
  membershipGift: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  tx = {
    $executeRaw: vi.fn(async () => {
      order.push('lock');
      return 1;
    }),
    modActivity: {
      count: vi.fn(async () => {
        order.push('count');
        return 0;
      }),
    },
    membershipGift: {
      create: vi.fn(async () => {
        order.push('create');
        return { id: 'gift_9' };
      }),
    },
  };
  db.$transaction.mockImplementation(async (cb: (client: unknown) => unknown) => cb(tx));
  db.user.findUnique.mockResolvedValue(liveUser());
  dbMock.dbRead.modActivity.count.mockResolvedValue(0);
  getRecipientGiftability.mockResolvedValue({ status: 'no-subscription' });
  fulfillMembershipGift.mockResolvedValue({ fulfilled: true, queued: true });
});

describe('compMembershipGift', () => {
  it('creates a $0 gift from the moderator, logs it in the same transaction, then fulfils it', async () => {
    const result = await compMembershipGift(valid());

    expect(tx.membershipGift.create).toHaveBeenCalledWith({
      data: {
        gifterId: MODERATOR,
        recipientId: RECIPIENT,
        holderId: RECIPIENT,
        tier: 'gold',
        months: 3,
        amountCents: 0,
        message: undefined,
        anonymous: false,
      },
      select: { id: true },
    });
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'user', entityId: RECIPIENT, activity: 'compMembershipGift:gold:3' },
      tx
    );
    expect(order).toEqual(['lock', 'count', 'create']);
    expect(fulfillMembershipGift).toHaveBeenCalledWith({ giftId: 'gift_9' });
    expect(result).toEqual({
      outcome: 'comped',
      giftId: 'gift_9',
      recipient: { id: RECIPIENT, username: 'recipient' },
      tier: 'gold',
      months: 3,
      fulfilled: true,
    });
  });

  it('refuses a message the blocklist rejects, before anything is written', async () => {
    throwOnBlockedUserContent.mockRejectedValueOnce(new Error('blocked content'));
    await expect(compMembershipGift(valid({ message: 'bad words' }))).rejects.toThrow(
      'blocked content'
    );
    expect(tx.membershipGift.create).not.toHaveBeenCalled();
  });

  it('screens the message it sends and stores the same text', async () => {
    await compMembershipGift(valid({ message: '  Thanks for everything  ' }));
    expect(throwOnBlockedUserContent).toHaveBeenCalledWith('Thanks for everything', {
      surface: 'membership-gift',
    });
    expect(tx.membershipGift.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ message: 'Thanks for everything' }),
      })
    );
  });

  it("counts only this moderator's comps from the last 24 hours toward the cap", async () => {
    await compMembershipGift(valid());
    const where = tx.modActivity.count.mock.calls[0][0].where;
    expect(where).toEqual({
      userId: MODERATOR,
      activity: { startsWith: 'compMembershipGift:' },
      createdAt: { gt: expect.any(Date) },
    });
    const ageMs = Date.now() - where.createdAt.gt.getTime();
    expect(Math.abs(ageMs - 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
  });

  it('a dry run reports and writes nothing', async () => {
    const result = await compMembershipGift(valid({ execute: false }));
    expect(result).toMatchObject({ outcome: 'would-comp', compsInLast24h: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.membershipGift.create).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
    expect(fulfillMembershipGift).not.toHaveBeenCalled();
  });

  it.each([
    ['banned', liveUser({ bannedAt: new Date() }), /banned/],
    ['muted', liveUser({ muted: true }), /muted/],
    ['deleted', liveUser({ deletedAt: new Date() }), /No live user/],
    ['missing', null, /No live user/],
  ])('refuses a %s recipient', async (_label, user, message) => {
    db.user.findUnique.mockResolvedValue(user);
    await expect(compMembershipGift(valid())).rejects.toThrow(message);
    expect(tx.membershipGift.create).not.toHaveBeenCalled();
  });

  it('refuses a moderator comping themselves', async () => {
    await expect(compMembershipGift(valid({ recipientId: MODERATOR }))).rejects.toThrow(
      /your own account/
    );
    expect(tx.membershipGift.create).not.toHaveBeenCalled();
  });

  it('refuses a membership that cannot take gifted months, but not an annual one', async () => {
    getRecipientGiftability.mockResolvedValue({
      status: 'blocked',
      reason: 'unsupported-provider',
    });
    await expect(compMembershipGift(valid())).rejects.toThrow(/cannot receive gifted months/);
    expect(tx.membershipGift.create).not.toHaveBeenCalled();

    getRecipientGiftability.mockResolvedValue({ status: 'blocked', reason: 'annual-interval' });
    await expect(compMembershipGift(valid())).resolves.toMatchObject({ outcome: 'comped' });
  });

  it('refuses months past the cap, and accepts the cap itself', async () => {
    await expect(compMembershipGift(valid({ months: 13 }))).rejects.toThrow(/1 to 12/);
    expect(tx.membershipGift.create).not.toHaveBeenCalled();
    await expect(compMembershipGift(valid({ months: 12 }))).resolves.toMatchObject({ months: 12 });
  });

  it('stops at the daily cap, inside the lock', async () => {
    tx.modActivity.count.mockResolvedValue(10);
    await expect(compMembershipGift(valid())).rejects.toThrow(/Daily limit of 10/);
    expect(tx.membershipGift.create).not.toHaveBeenCalled();

    tx.modActivity.count.mockResolvedValue(9);
    await expect(compMembershipGift(valid())).resolves.toMatchObject({ outcome: 'comped' });
  });

  it('reports a failed fulfilment instead of throwing into a retry that would comp twice', async () => {
    fulfillMembershipGift.mockRejectedValue(new Error('mail down'));
    await expect(compMembershipGift(valid())).resolves.toMatchObject({
      outcome: 'comped',
      giftId: 'gift_9',
      fulfilled: false,
    });
  });
});

describe('revokeCompMembershipGift', () => {
  const compGift = (over: Record<string, unknown> = {}) => ({
    id: 'gift_9',
    status: 'Fulfilled',
    holderId: RECIPIENT,
    monthsRemaining: 3,
    amountCents: 0,
    stripePaymentIntentId: null,
    stripeCheckoutSessionId: null,
    stripeSubscriptionId: null,
    ...over,
  });

  it('revokes a comp and logs it against the holder', async () => {
    db.membershipGift.findUnique.mockResolvedValue(compGift());
    const result = await revokeCompMembershipGift({
      giftId: 'gift_9',
      execute: true,
      moderatorId: MODERATOR,
    });
    expect(revokeMembershipGift).toHaveBeenCalledWith({ giftId: 'gift_9', reason: 'chargeback' });
    expect(trackModActivity).toHaveBeenCalledWith(MODERATOR, {
      entityType: 'user',
      entityId: RECIPIENT,
      activity: 'revokeCompMembershipGift:gift_9',
    });
    expect(result).toMatchObject({ outcome: 'revoked' });
  });

  it('a dry run changes nothing', async () => {
    db.membershipGift.findUnique.mockResolvedValue(compGift());
    await expect(
      revokeCompMembershipGift({ giftId: 'gift_9', moderatorId: MODERATOR })
    ).resolves.toMatchObject({ outcome: 'would-revoke' });
    expect(revokeMembershipGift).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['a paid gift', compGift({ amountCents: 3000, stripePaymentIntentId: 'pi_1' }), /was paid for/],
    ['a gift with its own subscription', compGift({ stripeSubscriptionId: 'sub_1' }), /engineer/],
    ['a used-up gift', compGift({ status: 'Completed' }), /nothing left/],
  ])('refuses %s', async (_label, gift, message) => {
    db.membershipGift.findUnique.mockResolvedValue(gift);
    await expect(
      revokeCompMembershipGift({ giftId: 'gift_9', execute: true, moderatorId: MODERATOR })
    ).rejects.toThrow(message);
    expect(revokeMembershipGift).not.toHaveBeenCalled();
  });
});
