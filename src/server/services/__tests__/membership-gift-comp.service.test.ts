import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Comped membership gifts: every refusal is paired with the valid call that writes, so a refusal
 * cannot pass because nothing ever writes. The gift row and its ModActivity row must share the
 * transaction client, since the daily cap counts ModActivity.
 */

const db = dbMock.dbWrite;

const { trackModActivity, fulfillMembershipGift, getRecipientGiftability, revokeMembershipGift } =
  vi.hoisted(() => ({
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
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));

import {
  compMembershipGift,
  revokeCompMembershipGift,
} from '~/server/services/membership-gift-comp.service';

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

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  db.user.findUnique.mockResolvedValue(liveUser());
  db.modActivity.count.mockImplementation(async () => {
    order.push('count');
    return 0;
  });
  db.$executeRaw.mockImplementation(async () => {
    order.push('lock');
    return 1;
  });
  db.membershipGift.create.mockImplementation(async () => {
    order.push('create');
    return { id: 'gift_9' };
  });
  getRecipientGiftability.mockResolvedValue({ status: 'no-subscription' });
  fulfillMembershipGift.mockResolvedValue({ fulfilled: true, queued: true });
});

describe('compMembershipGift', () => {
  it('creates a $0 gift from the moderator, logs it in the same transaction, then fulfils it', async () => {
    const result = await compMembershipGift(valid());

    expect(db.membershipGift.create).toHaveBeenCalledWith({
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
      db
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

  it('a dry run reports and writes nothing', async () => {
    const result = await compMembershipGift(valid({ execute: false }));
    expect(result).toMatchObject({ outcome: 'would-comp', compsInLast24h: 0 });
    expect(db.membershipGift.create).not.toHaveBeenCalled();
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
    expect(db.membershipGift.create).not.toHaveBeenCalled();
  });

  it('refuses a moderator comping themselves', async () => {
    await expect(compMembershipGift(valid({ recipientId: MODERATOR }))).rejects.toThrow(
      /your own account/
    );
    expect(db.membershipGift.create).not.toHaveBeenCalled();
  });

  it('refuses a membership that cannot take gifted months, but not an annual one', async () => {
    getRecipientGiftability.mockResolvedValue({
      status: 'blocked',
      reason: 'unsupported-provider',
    });
    await expect(compMembershipGift(valid())).rejects.toThrow(/cannot receive gifted months/);
    expect(db.membershipGift.create).not.toHaveBeenCalled();

    getRecipientGiftability.mockResolvedValue({ status: 'blocked', reason: 'annual-interval' });
    await expect(compMembershipGift(valid())).resolves.toMatchObject({ outcome: 'comped' });
  });

  it('refuses months past the cap, and accepts the cap itself', async () => {
    await expect(compMembershipGift(valid({ months: 13 }))).rejects.toThrow(/1 to 12/);
    expect(db.membershipGift.create).not.toHaveBeenCalled();
    await expect(compMembershipGift(valid({ months: 12 }))).resolves.toMatchObject({ months: 12 });
  });

  it('stops at the daily cap, inside the lock', async () => {
    db.modActivity.count.mockResolvedValue(10);
    await expect(compMembershipGift(valid())).rejects.toThrow(/Daily limit of 10/);
    expect(db.membershipGift.create).not.toHaveBeenCalled();

    db.modActivity.count.mockResolvedValue(9);
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
