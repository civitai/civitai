import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `mintSupportMembershipCode` — support's way to make a customer whole with a membership code.
 *
 * Every refusal is paired with the control that succeeds one step inside the bound, so a refusal
 * cannot pass because nothing ever writes. The code row and its ModActivity row must go through the
 * SAME transaction client: the daily cap counts ModActivity, so an audit row written outside the
 * transaction could be lost while the code survives, and the cap would undercount.
 */

const { trackModActivity } = vi.hoisted(() => ({
  trackModActivity: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));

import {
  SUPPORT_MEMBERSHIP_CODE_LIMITS,
  mintSupportMembershipCode,
} from '~/server/services/support-membership-code.service';

const MODERATOR = 990000007;
const TARGET = 8675309;
const NOW = new Date('2026-10-13T12:00:00.000Z');

type Tx = {
  $executeRaw: ReturnType<typeof vi.fn>;
  modActivity: { count: ReturnType<typeof vi.fn> };
  redeemableCode: { create: ReturnType<typeof vi.fn> };
};
let tx: Tx;
let order: string[];

const valid = () => ({
  forUserId: TARGET,
  tier: 'silver' as const,
  months: 2,
  reason: 'Support ticket: gift ended early',
  moderatorId: MODERATOR,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  order = [];
  tx = {
    $executeRaw: vi.fn(async () => {
      order.push('lock');
      return [];
    }),
    modActivity: {
      count: vi.fn(async () => {
        order.push('count');
        return 0;
      }),
    },
    redeemableCode: {
      create: vi.fn(async ({ data }: { data: { code: string } }) => {
        order.push('create');
        return data;
      }),
    },
  };
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: unknown) =>
    (fn as (t: Tx) => unknown)(tx)
  );
  dbMock.dbWrite.price.findFirst.mockResolvedValue({
    id: 'silver-monthly',
    product: { metadata: { tier: 'silver' } },
  });
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: TARGET, deletedAt: null });
  trackModActivity.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bounds', () => {
  it('the limits are the agreed ones', () => {
    expect(SUPPORT_MEMBERSHIP_CODE_LIMITS).toEqual({
      maxMonths: 6,
      dailyPerModerator: 10,
      expiryDays: 30,
    });
  });

  it.each([0, 7, 2.5, -1])('refuses %s months and writes nothing', async (months) => {
    await expect(mintSupportMembershipCode({ ...valid(), months })).rejects.toThrow(/months/i);
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
  });

  it.each([1, 6])('control: %s months is minted', async (months) => {
    await mintSupportMembershipCode({ ...valid(), months });
    expect(tx.redeemableCode.create).toHaveBeenCalledTimes(1);
    expect(tx.redeemableCode.create.mock.calls[0][0].data.unitValue).toBe(months);
  });

  it('refuses an unknown tier and writes nothing', async () => {
    await expect(
      mintSupportMembershipCode({ ...valid(), tier: 'platinum' as unknown as 'gold' })
    ).rejects.toThrow(/tier/i);
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
  });

  it('only accepts the active Civitai-provider monthly price for the tier', async () => {
    await mintSupportMembershipCode(valid());
    expect(dbMock.dbWrite.price.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'silver-monthly', active: true, product: { provider: 'Civitai' } },
      })
    );
  });

  it('refuses when that price is missing or inactive', async () => {
    dbMock.dbWrite.price.findFirst.mockResolvedValue(null);
    await expect(mintSupportMembershipCode(valid())).rejects.toThrow(/price/i);
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
  });

  it("refuses when the price's product is a different tier", async () => {
    dbMock.dbWrite.price.findFirst.mockResolvedValue({
      id: 'silver-monthly',
      product: { metadata: { tier: 'gold' } },
    });
    await expect(mintSupportMembershipCode(valid())).rejects.toThrow(/tier/i);
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['deleted', { id: TARGET, deletedAt: new Date('2026-01-01') }],
  ])('refuses a %s target account', async (_label, row) => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue(row);
    await expect(mintSupportMembershipCode(valid())).rejects.toThrow(/user/i);
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
  });

  it('refuses a moderator minting for their own account (the code is bound to it)', async () => {
    await expect(mintSupportMembershipCode({ ...valid(), forUserId: MODERATOR })).rejects.toThrow(
      /own account/
    );
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
  });

  it('refuses a blank reason', async () => {
    await expect(mintSupportMembershipCode({ ...valid(), reason: '   ' })).rejects.toThrow(
      /reason/i
    );
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
  });
});

describe('daily cap per moderator', () => {
  it('refuses the 11th code in 24 hours, as a rate limit (429)', async () => {
    tx.modActivity.count.mockResolvedValue(10);
    await expect(mintSupportMembershipCode(valid())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringMatching(/10/),
    });
    expect(tx.redeemableCode.create).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('control: the 10th code is minted', async () => {
    tx.modActivity.count.mockResolvedValue(9);
    await mintSupportMembershipCode(valid());
    expect(tx.redeemableCode.create).toHaveBeenCalledTimes(1);
  });

  it("counts THIS moderator's mints over the last 24 hours", async () => {
    await mintSupportMembershipCode(valid());
    expect(tx.modActivity.count).toHaveBeenCalledWith({
      where: {
        userId: MODERATOR,
        activity: { startsWith: 'mintMembershipCode:' },
        createdAt: { gt: new Date('2026-10-12T12:00:00.000Z') },
      },
    });
  });

  it('takes the per-moderator lock before counting, and counts before writing', async () => {
    await mintSupportMembershipCode(valid());
    expect(order).toEqual(['lock', 'count', 'create']);
  });

  it('the lock is keyed on the moderator, so two moderators never wait on each other', async () => {
    await mintSupportMembershipCode(valid());
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    // The exact text: the `::int` is load-bearing. Prisma binds a JS number as int8 and Postgres has
    // no pg_advisory_xact_lock(int4, int8) — without the cast every mint fails at this line.
    expect(strings.join('?')).toBe(
      "SELECT pg_advisory_xact_lock(hashtext('support-membership-code'), ?::int)"
    );
    expect(values).toEqual([MODERATOR]);
  });
});

describe('what it writes', () => {
  it('one Membership code: unit value = months, the tier price, 30-day expiry, audit metadata', async () => {
    const result = await mintSupportMembershipCode(valid());
    const data = tx.redeemableCode.create.mock.calls[0][0].data;
    expect(data).toEqual({
      code: expect.stringMatching(/^MB-[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      type: 'Membership',
      unitValue: 2,
      priceId: 'silver-monthly',
      expiresAt: new Date('2026-11-12T12:00:00.000Z'),
      metadata: {
        source: 'moderator-membership-code',
        mintedBy: MODERATOR,
        forUserId: TARGET,
        reason: 'Support ticket: gift ended early',
      },
    });
    expect(result).toEqual({
      code: data.code,
      expiresAt: data.expiresAt,
      tier: 'silver',
      months: 2,
    });
  });

  it('records the ModActivity row through the transaction client, against the target user', async () => {
    await mintSupportMembershipCode(valid());
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(
      MODERATOR,
      { entityType: 'user', entityId: TARGET, activity: 'mintMembershipCode:silver:2' },
      tx
    );
  });

  it('stores the reason trimmed', async () => {
    await mintSupportMembershipCode({ ...valid(), reason: '  Ticket 9  ' });
    expect(tx.redeemableCode.create.mock.calls[0][0].data.metadata.reason).toBe('Ticket 9');
  });

  it('a failed audit write fails the mint (so the transaction rolls the code back)', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('insert failed'));
    await expect(mintSupportMembershipCode(valid())).rejects.toThrow('insert failed');
  });

  it('a code collision is a 409 (nothing minted, safe to retry), not a 500', async () => {
    tx.redeemableCode.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    await expect(mintSupportMembershipCode(valid())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('control: any other create failure is passed through unchanged', async () => {
    tx.redeemableCode.create.mockRejectedValueOnce(new Error('connection reset'));
    await expect(mintSupportMembershipCode(valid())).rejects.toThrow('connection reset');
  });

  it('does not carry the code itself into ModActivity (it is a bearer secret)', async () => {
    await mintSupportMembershipCode(valid());
    const code = tx.redeemableCode.create.mock.calls[0][0].data.code as string;
    expect(JSON.stringify(trackModActivity.mock.calls)).not.toContain(code);
  });
});
