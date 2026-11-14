import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as PrefixRefund from '~/server/services/buzz-prefix-refund';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createFakeBuzzLedger } from './buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from './charge-lock.fake';

/**
 * A new Buzz bounty whose creation charge ends with an unknown outcome (the ledger committed, the
 * response was lost) must charge once across the creator's retry under one key, create the bounty
 * once, and tell the creator it may have gone through when a resend cannot settle it. The charge
 * runs outside any transaction; the bounty is written after it, under the key's lock.
 */

const { buzz, prefixRefund, getUserBuzzAccount } = vi.hoisted(() => ({
  buzz: {
    createMultiAccountBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    getTransactionByExternalId: vi.fn(),
  },
  prefixRefund: { getPrefixRefundState: vi.fn() },
  getUserBuzzAccount: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  ...buzz,
  getUserBuzzAccount,
}));
vi.mock('~/server/services/buzz-prefix-refund', async (importOriginal) => ({
  ...(await importOriginal<typeof PrefixRefund>()),
  ...prefixRefund,
}));
// Hand-listed, as in bounty-payout-lock.service.test.ts: each pulls a large graph at load.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  checkEntityImageKeys: vi.fn(async () => []),
  createEntityImages: vi.fn(async () => []),
  updateEntityImages: vi.fn(async () => []),
  enqueueImageIngestion: vi.fn(),
  invalidateManyImageExistence: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({
  userBountyCountCache: { refresh: vi.fn() },
  userBountyEntryCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/email/templates', () => ({
  bountyRefundedEmail: { send: vi.fn() },
}));

import { dbMock } from '~/__tests__/mocks';

const { createBounty } = await import('~/server/services/bounty.service');

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';
const USER = 42;
const UNIT_AMOUNT = 5_000;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
// Minted a minute ago, as a retry would carry it: not the request's own clock.
const CHARGED_AT = Date.now() - 60_000;
const PREFIX = `bounty-k-${USER}-${KEY}-${CHARGED_AT}`;
const FIRST_ID = 9001;

type BountyRow = { id: number; userId: number; name: string; details: unknown };
type BenefactorRow = { userId: number; bountyId: number; buzzTransactionId: string[] };

let ledger: ReturnType<typeof createFakeBuzzLedger>;
let bounties: BountyRow[];
let benefactors: BenefactorRow[];
let nextId: number;
let locks = createFakeAdvisoryLocks();
const benefactorCreate = vi.fn();

const create = (
  overrides: { idempotencyKey?: string; chargedAt?: number; unitAmount?: number } = {}
) =>
  createBounty({
    userId: USER,
    name: 'A bounty',
    description: 'Some description',
    unitAmount: UNIT_AMOUNT,
    currency: 'BUZZ',
    buzzType: 'yellow',
    startsAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    mode: 'Individual',
    type: 'ModelCreation',
    entryMode: 'BenefactorsOnly',
    minBenefactorUnitAmount: 1,
    images: [{ url: '00000000-0000-4000-8000-000000000000' }],
    ...overrides,
  } as never);
const keyed = (key = KEY, chargedAt = CHARGED_AT) => create({ idempotencyKey: key, chargedAt });

beforeEach(() => {
  vi.clearAllMocks();
  bounties = [];
  benefactors = [];
  nextId = FIRST_ID;
  benefactorCreate.mockImplementation(async ({ data }: { data: BenefactorRow }) => {
    benefactors.push(data);
    return data;
  });
  getUserBuzzAccount.mockImplementation(async () => [{ balance: ledger.balanceOf(USER) }]);

  const tx = {
    bounty: {
      create: async ({ data }: { data: Omit<BountyRow, 'id'> }) => {
        const row = { ...data, id: nextId++ } as BountyRow;
        bounties.push(row);
        return row;
      },
    },
    bountyBenefactor: {
      create: (args: { data: BenefactorRow }) => benefactorCreate(args),
      findFirst: async ({
        where,
      }: {
        where: { userId: number; buzzTransactionId: { has: string } };
      }) => {
        const b = benefactors.find(
          (x) =>
            x.userId === where.userId && x.buzzTransactionId.includes(where.buzzTransactionId.has)
        );
        return b ? { bounty: bounties.find((row) => row.id === b.bountyId)! } : null;
      },
    },
  };
  locks = createFakeAdvisoryLocks();
  dbMock.dbWrite.$transaction.mockImplementation(((
    cb: (tx: unknown) => Promise<unknown>,
    options?: { timeout?: number }
  ) => locks.transaction(cb, tx, options)) as never);

  for (const fn of [...Object.values(buzz), ...Object.values(prefixRefund)]) fn.mockReset();
  ledger = createFakeBuzzLedger();
  buzz.createMultiAccountBuzzTransaction.mockImplementation(
    ledger.createMultiAccountBuzzTransaction
  );
  buzz.refundMultiAccountTransaction.mockImplementation(ledger.refundMultiAccountTransaction);
  buzz.getMultiAccountTransactionsByPrefix.mockImplementation(
    ledger.getMultiAccountTransactionsByPrefix
  );
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
  prefixRefund.getPrefixRefundState.mockImplementation(ledger.getPrefixRefundState);
});

describe('a keyed bounty creation across an unknown outcome', () => {
  it('a retry with the same key after an unanswered charge charges once and creates one bounty', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(keyed()).rejects.toMatchObject({ message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
    ledger.clearFaults();
    expect(bounties).toHaveLength(0);

    const created = await keyed();

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].amount).toBe(UNIT_AMOUNT);
    expect(bounties).toHaveLength(1);
    expect(benefactors).toEqual([
      expect.objectContaining({ userId: USER, bountyId: created.id, buzzTransactionId: [PREFIX] }),
    ]);
  });

  it('a retry after the bounty was created (response lost) answers with it and charges nothing more', async () => {
    const first = await keyed();
    const again = await keyed();

    expect(again.id).toBe(first.id);
    expect(ledger.charges()).toHaveLength(1);
    expect(bounties).toHaveLength(1);
    expect(benefactors).toHaveLength(1);
  });

  it('answers "may have gone through" when the resend also fails, and creates nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await keyed().catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(bounties).toHaveLength(0);
    expect(ledger.refunds()).toHaveLength(0);
  });

  // The first charge spent the balance. The app's balance check would refuse the retry as
  // "insufficient funds" (releasing the client's key); the held charge is found first.
  it('a retry whose balance the first charge spent creates the bounty from that charge', async () => {
    ledger.setBalance(USER, UNIT_AMOUNT);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(keyed()).rejects.toThrow();
    ledger.clearFaults();
    expect(ledger.balanceOf(USER)).toBe(0);

    await keyed();

    expect(ledger.charges()).toHaveLength(1);
    expect(bounties).toHaveLength(1);
  });

  it('a short balance with nothing held is still refused before charging', async () => {
    ledger.setBalance(USER, UNIT_AMOUNT - 1);

    await expect(keyed()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(bounties).toHaveLength(0);
  });

  it('two requests with one key in flight: one charge, one bounty', async () => {
    ledger.queueFault('hang');
    const first = keyed();
    while (!ledger.isHung()) await settle();
    const second = keyed();
    await settle();
    ledger.releaseHung();
    const [a, b] = await Promise.all([first, second]);

    expect(ledger.charges()).toHaveLength(1);
    expect(bounties).toHaveLength(1);
    expect(a.id).toBe(b.id);
  });

  it('holds no transaction while the Buzz charge is pending', async () => {
    ledger.queueFault('hang');
    const created = keyed();
    while (!ledger.isHung()) await settle();
    expect(locks.open()).toBe(0);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    ledger.releaseHung();
    await created;
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(locks.taken()).toEqual([PREFIX]);
  });

  // Award pricing reads the charge time from the prefix's last segment, so it must be the key's
  // time, the same on every retry, never the request's.
  it('files the charge under the creator, the key and the key time, the time last', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await keyed().catch(() => undefined);
    ledger.clearFaults();
    await keyed();

    expect(ledger.charges().map((c) => c.externalTransactionId)).toEqual([`${PREFIX}-0`]);
    expect(Number(benefactors[0].buzzTransactionId[0].split('-').at(-1))).toBe(CHARGED_AT);
  });

  // The bounty does not exist when it is charged; the benefactor row links the two.
  it('charges as a bounty with no entity id, and links the charge through the benefactor row', async () => {
    const created = await keyed();

    expect(created.id).toBe(FIRST_ID);
    const [charge] = buzz.createMultiAccountBuzzTransaction.mock.calls[0];
    expect(charge).toMatchObject({ type: TransactionType.Bounty });
    expect(charge.details).toEqual({ entityType: 'Bounty' });
    expect(benefactors).toEqual([
      expect.objectContaining({ bountyId: FIRST_ID, buzzTransactionId: [PREFIX] }),
    ]);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('a new bounty (a new key) charges again', async () => {
    await keyed();
    await keyed(OTHER_KEY);

    expect(ledger.charges()).toHaveLength(2);
    expect(bounties).toHaveLength(2);
  });

  it('a retry under the same key for a different amount is refused, and creates nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await keyed().catch(() => undefined);
    ledger.clearFaults();

    await expect(
      create({ idempotencyKey: KEY, chargedAt: CHARGED_AT, unitAmount: UNIT_AMOUNT + 1_000 })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This payment was already started with different details. Please start it again.',
    });
    expect(bounties).toHaveLength(0);
  });

  it('refunds the charge when the bounty cannot be written, and refuses the retry as refunded', async () => {
    benefactorCreate.mockRejectedValueOnce(new Error('write failed'));

    await expect(keyed()).rejects.toThrow('write failed');
    expect(ledger.refunds()).toHaveLength(1);
    expect(buzz.refundMultiAccountTransaction.mock.calls[0][1]).toEqual({
      timeoutMs: 10_000,
      retries: 0,
    });

    await expect(keyed()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
  });

  it('no pooled connection for the write is "may have gone through", with no refund', async () => {
    dbMock.dbWrite.$transaction.mockImplementationOnce((() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: 'test' })
      )) as never);

    await expect(keyed()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(0);

    await keyed();
    expect(ledger.charges()).toHaveLength(1);
    expect(bounties).toHaveLength(1);
  });
});

describe('a bounty creation without a usable key', () => {
  it('is charged inside the creation transaction under a new prefix per call, as before', async () => {
    let clock = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
    await create();
    await create();
    now.mockRestore();

    const ids = ledger.charges().map((c) => c.externalTransactionId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids)
      expect(id).toMatch(new RegExp(`^bounty-\\d+-${USER}-[0-9a-f]{12}-\\d+-0$`));
    expect(buzz.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
    expect(locks.taken()).toEqual([]);
    expect(bounties).toHaveLength(2);
  });

  // A client clock far off the server's: the key is not used, rather than the creation refused.
  it('a key whose charge time is outside the window is charged as before keys', async () => {
    await keyed(KEY, Date.now() - 30 * 24 * 60 * 60 * 1000);
    await keyed(KEY, Date.now() + 30 * 24 * 60 * 60 * 1000);

    const ids = ledger.charges().map((c) => c.externalTransactionId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).not.toContain(KEY);
    expect(locks.taken()).toEqual([]);
  });
});
