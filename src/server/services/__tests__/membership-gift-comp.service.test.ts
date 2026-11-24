import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as KyselyDb from '~/server/db/kyselyDb';

/**
 * Comped membership gifts: every refusal is paired with the valid call that writes, so a refusal
 * cannot pass because nothing ever writes. The gift row and its ModActivity row must share the
 * transaction client, since the daily cap counts ModActivity. The permission check is the real
 * `hasModeratorGrant`, fed through the database boundary.
 */

const db = dbMock.dbWrite;

const { grantRow } = vi.hoisted(() => ({ grantRow: { roles: [] as string[] } }));
vi.mock('~/server/db/kyselyDb', async (importOriginal) => {
  const chain = {
    selectFrom: () => chain,
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => grantRow,
  };
  return {
    ...(await importOriginal<typeof KyselyDb>()),
    kyselyWrite: chain,
  };
});

import type { compGiftDeps } from '~/server/services/membership-gift-comp.service';
import {
  compMembershipGift,
  revokeCompMembershipGift,
} from '~/server/services/membership-gift-comp.service';

const MODERATOR = 990000007;
const RECIPIENT = 990100021;
const ROLE = 'moderator:support';
const actor = { id: MODERATOR, roles: [ROLE] };

let deps: {
  trackModActivity: ReturnType<typeof vi.fn>;
  fulfillMembershipGift: ReturnType<typeof vi.fn>;
  getRecipientGiftability: ReturnType<typeof vi.fn>;
  throwOnBlockedUserContent: ReturnType<typeof vi.fn>;
};

const fakeDeps = () => deps as unknown as typeof compGiftDeps;

const valid = (over: Record<string, unknown> = {}) =>
  ({
    recipientId: RECIPIENT,
    tier: 'gold' as const,
    months: 3,
    reason: 'Thank-you for community work',
    execute: true,
    actor,
    deps: fakeDeps(),
    ...over,
  } as Parameters<typeof compMembershipGift>[0]);

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
  grantRow.roles = [ROLE];
  deps = {
    trackModActivity: vi.fn(async () => undefined),
    fulfillMembershipGift: vi.fn(async () => ({ fulfilled: true, queued: true })),
    getRecipientGiftability: vi.fn(async () => ({ status: 'no-subscription' })),
    throwOnBlockedUserContent: vi.fn(async () => undefined),
  };
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
});

describe('the comp permission', () => {
  it('refuses a moderator whose roles do not hold user.membership.gift.comp, before reading anything', async () => {
    grantRow.roles = ['moderator:other'];
    await expect(compMembershipGift(valid())).rejects.toThrow(/user\.membership\.gift\.comp/);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(tx.membershipGift.create).not.toHaveBeenCalled();
  });

  it('refuses revoking a comp without it too', async () => {
    grantRow.roles = [];
    await expect(
      revokeCompMembershipGift({ giftId: 'gift_9', execute: true, actor, deps: fakeDeps() })
    ).rejects.toThrow(/user\.membership\.gift\.comp/);
    expect(db.membershipGift.findUnique).not.toHaveBeenCalled();
    expect(db.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it('lets moderator:admin through with no grant row', async () => {
    grantRow.roles = [];
    await expect(
      compMembershipGift(valid({ actor: { id: MODERATOR, roles: ['moderator:admin'] } }))
    ).resolves.toMatchObject({ outcome: 'comped' });
  });
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
    expect(deps.trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'user', entityId: RECIPIENT, activity: 'compMembershipGift:gold:3' },
      tx
    );
    expect(order).toEqual(['lock', 'count', 'create']);
    expect(deps.fulfillMembershipGift).toHaveBeenCalledWith({ giftId: 'gift_9' });
    expect(result).toEqual({
      outcome: 'comped',
      giftId: 'gift_9',
      recipient: { id: RECIPIENT, username: 'recipient' },
      tier: 'gold',
      months: 3,
      fulfilled: true,
    });
  });

  it('serialises one moderator by an int4 advisory lock on the comp class and their id', async () => {
    await compMembershipGift(valid());
    const [strings, ...values] = tx.$executeRaw.mock.calls[0];
    const sql = (strings as string[]).join('?');
    expect(sql).toContain('pg_advisory_xact_lock(');
    expect(sql.match(/::int/g)).toHaveLength(2);
    expect(values).toEqual([0x4d470001, MODERATOR]);
  });

  it('logs the comp, with its reason, to Axiom', async () => {
    await compMembershipGift(valid());
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'comp',
        giftId: 'gift_9',
        reason: 'Thank-you for community work',
      }),
      'webhooks'
    );
  });

  it('refuses a message the blocklist rejects, before anything is written', async () => {
    deps.throwOnBlockedUserContent.mockRejectedValueOnce(new Error('blocked content'));
    await expect(compMembershipGift(valid({ message: 'bad words' }))).rejects.toThrow(
      'blocked content'
    );
    expect(tx.membershipGift.create).not.toHaveBeenCalled();
  });

  it('screens the message it sends and stores the same text', async () => {
    await compMembershipGift(valid({ message: '  Thanks for everything  ' }));
    expect(deps.throwOnBlockedUserContent).toHaveBeenCalledWith('Thanks for everything', {
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
    expect(deps.trackModActivity).not.toHaveBeenCalled();
    expect(deps.fulfillMembershipGift).not.toHaveBeenCalled();
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
    deps.getRecipientGiftability.mockResolvedValue({
      status: 'blocked',
      reason: 'unsupported-provider',
    });
    await expect(compMembershipGift(valid())).rejects.toThrow(/cannot receive gifted months/);
    expect(tx.membershipGift.create).not.toHaveBeenCalled();

    deps.getRecipientGiftability.mockResolvedValue({
      status: 'blocked',
      reason: 'annual-interval',
    });
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
    deps.fulfillMembershipGift.mockRejectedValue(new Error('mail down'));
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
    acceptedAt: null,
    amountCents: 0,
    stripePaymentIntentId: null,
    stripeCheckoutSessionId: null,
    ...over,
  });
  const revoke = (execute: boolean) =>
    revokeCompMembershipGift({ giftId: 'gift_9', execute, actor, deps: fakeDeps() });

  beforeEach(() => {
    db.membershipGift.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each([
    ['Fulfilled', compGift()],
    ['Pending', compGift({ status: 'Pending', monthsRemaining: 0 })],
  ])(
    'revokes an unaccepted %s comp in one write conditioned on it staying unaccepted',
    async (_l, gift) => {
      db.membershipGift.findUnique.mockResolvedValue(gift);
      await expect(revoke(true)).resolves.toMatchObject({ outcome: 'revoked' });
      expect(db.membershipGift.updateMany).toHaveBeenCalledWith({
        where: { id: 'gift_9', acceptedAt: null, status: { in: ['Pending', 'Fulfilled'] } },
        data: { status: 'Revoked', monthsRemaining: 0 },
      });
      expect(deps.trackModActivity).toHaveBeenCalledWith(MODERATOR, {
        entityType: 'user',
        entityId: RECIPIENT,
        activity: 'revokeCompMembershipGift:gift_9',
      });
    }
  );

  it('loses to an accept that claimed the gift first, and writes no audit row', async () => {
    db.membershipGift.findUnique.mockResolvedValue(compGift());
    db.membershipGift.updateMany.mockResolvedValue({ count: 0 });
    await expect(revoke(true)).rejects.toThrow(/accepted or changed just now/);
    expect(deps.trackModActivity).not.toHaveBeenCalled();
  });

  it('a dry run changes nothing and writes no audit row', async () => {
    db.membershipGift.findUnique.mockResolvedValue(compGift());
    await expect(revoke(false)).resolves.toMatchObject({ outcome: 'would-revoke' });
    expect(db.membershipGift.updateMany).not.toHaveBeenCalled();
    expect(deps.trackModActivity).not.toHaveBeenCalled();
  });

  it('answers already-revoked without revoking again', async () => {
    db.membershipGift.findUnique.mockResolvedValue(compGift({ status: 'Revoked' }));
    await expect(revoke(true)).resolves.toEqual({ outcome: 'already-revoked', status: 'Revoked' });
    expect(db.membershipGift.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['a paid gift', compGift({ amountCents: 3000, stripePaymentIntentId: 'pi_1' }), /was paid for/],
    [
      'a gift with only a checkout session',
      compGift({ stripeCheckoutSessionId: 'cs_1' }),
      /was paid for/,
    ],
    ['an accepted comp', compGift({ status: 'Active', acceptedAt: new Date() }), /accepted/],
    ['a used-up comp', compGift({ status: 'Completed', acceptedAt: new Date() }), /accepted/],
  ])('refuses %s', async (_label, gift, message) => {
    db.membershipGift.findUnique.mockResolvedValue(gift);
    await expect(revoke(true)).rejects.toThrow(message);
    expect(db.membershipGift.updateMany).not.toHaveBeenCalled();
  });
});
