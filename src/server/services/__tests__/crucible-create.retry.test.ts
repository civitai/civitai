import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as PrefixRefund from '~/server/services/buzz-prefix-refund';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as CrucibleEligibilityService from '~/server/services/crucible-eligibility.service';
import type * as CoverImageService from '~/server/services/cover-image.service';
import type * as TextModerationService from '~/server/services/text-moderation.service';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as NotificationService from '~/server/services/notification.service';
import { CRUCIBLE_PRIZE_CUSTOMIZATION_COST } from '~/shared/constants/crucible.constants';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { createFakeBuzzLedger, timeoutError } from './buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from './charge-lock.fake';

/**
 * A keyed crucible creation charges two legs (the setup fee, then the seeded prize pool) after
 * inserting its row unpaid. Across the creator's retries under one key each leg is charged once
 * and one crucible opens; a leg whose outcome is unknown is resumed on the retry, and a leg that
 * is refused refunds the legs before it. Without a key nothing changes.
 */

const {
  buzz,
  prefixRefund,
  getUserBuzzAccount,
  assertCanCreateCrucible,
  throwOnBlockedUserContent,
  resolveCoverImageId,
  submitTextModeration,
  createNotification,
} = vi.hoisted(() => ({
  buzz: {
    createMultiAccountBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    getTransactionByExternalId: vi.fn(),
  },
  prefixRefund: { getPrefixRefundState: vi.fn() },
  getUserBuzzAccount: vi.fn(),
  assertCanCreateCrucible: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
  resolveCoverImageId: vi.fn(),
  submitTextModeration: vi.fn(),
  createNotification: vi.fn(),
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
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration,
}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/crucible-eligibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEligibilityService>()),
  assertCanCreateCrucible,
}));
vi.mock('~/server/services/cover-image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverImageService>()),
  resolveCoverImageId,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent,
}));

import { dbMock } from '~/__tests__/mocks';

const { createCrucible } = await import('~/server/services/crucible.service');

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';
const USER = 4;
// 24 hours is free and the split below is custom, so the customization fee is the whole setup cost.
const SETUP_FEE = CRUCIBLE_PRIZE_CUSTOMIZATION_COST;
const SEED = 5_000;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const SETUP_PREFIX = `crucible-setup-k-${USER}-${KEY}`;
const SEED_PREFIX = `crucible-seed-k-${USER}-${KEY}`;
const LOCK = `crucible-create-k-${USER}-${KEY}`;

type CrucibleRow = {
  id: number;
  userId: number;
  status: string;
  buzzTransactionId?: string | null;
  seedTransactionId?: string | null;
  startAt?: Date | null;
};

let ledger: ReturnType<typeof createFakeBuzzLedger>;
let rows: CrucibleRow[];
let nextId: number;
let locks = createFakeAdvisoryLocks();
const crucibleUpdate = vi.fn();

const create = (idempotencyKey?: string, overrides: Record<string, unknown> = {}) =>
  createCrucible({
    userId: USER,
    name: 'Test Crucible',
    description: 'A description',
    coverImage: { url: '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900', width: 512, height: 704 },
    nsfwLevel: 1,
    entryFee: 100,
    entryLimit: 1,
    prizePositions: { '1': 70, '2': 30 },
    duration: 24,
    seededPrizePool: SEED,
    idempotencyKey,
    ...overrides,
  } as never);

/** The creator's charges by leg, refunds excluded. */
const legCharges = (prefix: string) =>
  ledger.charges().filter((c) => c.externalTransactionId.startsWith(prefix));
const opened = () => rows.filter((r) => r.status !== CrucibleStatus.Pending || r.startAt);

const findKeyed = async ({
  where,
}: {
  where: { userId: number; OR: ({ buzzTransactionId: string } | { seedTransactionId: string })[] };
}) =>
  rows.find(
    (r) =>
      r.userId === where.userId &&
      where.OR.some((o) =>
        'buzzTransactionId' in o
          ? r.buzzTransactionId === o.buzzTransactionId
          : r.seedTransactionId === o.seedTransactionId
      )
  ) ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  nextId = 1;
  getUserBuzzAccount.mockImplementation(async () => [
    { balance: ledger.balanceOf(USER), type: 'yellow' },
  ]);
  assertCanCreateCrucible.mockResolvedValue(undefined);
  throwOnBlockedUserContent.mockResolvedValue(undefined);
  resolveCoverImageId.mockResolvedValue(99);
  dbMock.dbRead.modelVersion.count.mockResolvedValue(0);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);

  dbMock.dbWrite.crucible.create.mockImplementation((async ({
    data,
  }: {
    data: Omit<CrucibleRow, 'id'>;
  }) => {
    const row = { ...data, id: nextId++ };
    rows.push(row);
    return { ...row };
  }) as never);
  crucibleUpdate.mockImplementation(
    async ({ where, data }: { where: { id: number }; data: Partial<CrucibleRow> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`no crucible ${where.id}`);
      Object.assign(row, data);
      return { ...row };
    }
  );
  dbMock.dbWrite.crucible.update.mockImplementation(((args: never) =>
    crucibleUpdate(args)) as never);
  dbMock.dbWrite.crucible.delete.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const index = rows.findIndex((r) => r.id === where.id);
    const [row] = rows.splice(index, 1);
    return row;
  }) as never);
  dbMock.dbWrite.crucible.findFirst.mockImplementation(findKeyed as never);
  dbMock.dbWrite.crucible.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      rows.find((r) => r.id === where.id) ?? null) as never
  );

  locks = createFakeAdvisoryLocks();
  dbMock.dbWrite.$transaction.mockImplementation(((
    cb: (tx: unknown) => Promise<unknown>,
    options?: { timeout?: number }
  ) =>
    locks.transaction(
      cb,
      {
        crucible: {
          findFirst: (args: never) => findKeyed(args),
          update: (args: never) => crucibleUpdate(args),
        },
      },
      options
    )) as never);

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

describe('a keyed crucible creation across an unknown outcome', () => {
  it('a retry with the same key after an unanswered setup charge charges each leg once and opens one crucible', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(create(KEY)).rejects.toMatchObject({ message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
    ledger.clearFaults();
    // The unpaid row is gone; the setup fee is held for the retry.
    expect(rows).toHaveLength(0);
    expect(ledger.refunds()).toHaveLength(0);

    const crucible = await create(KEY);

    expect(legCharges(SETUP_PREFIX).map((c) => c.amount)).toEqual([SETUP_FEE]);
    expect(legCharges(SEED_PREFIX).map((c) => c.amount)).toEqual([SEED]);
    expect(rows).toHaveLength(1);
    expect(crucible).toMatchObject({
      buzzTransactionId: SETUP_PREFIX,
      seedTransactionId: SEED_PREFIX,
      status: CrucibleStatus.Active,
    });
  });

  it('a retry after the crucible opened (response lost) answers with it and charges nothing more', async () => {
    const first = await create(KEY);
    const again = await create(KEY);

    expect(again.id).toBe(first.id);
    expect(ledger.charges()).toHaveLength(2);
    expect(rows).toHaveLength(1);
    // Answered before anything a second creation would do: no row, no limit check.
    expect(dbMock.dbWrite.crucible.create).toHaveBeenCalledTimes(1);
    expect(assertCanCreateCrucible).toHaveBeenCalledTimes(1);
  });

  it('answers "may have gone through" when the resend also fails, and opens nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await create(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(rows).toHaveLength(0);
    expect(ledger.refunds()).toHaveLength(0);
  });

  it('two requests with one key in flight: each leg charged once, one crucible', async () => {
    ledger.queueFault('hang');
    const first = create(KEY);
    while (!ledger.isHung()) await settle();
    const second = create(KEY);
    await settle();
    ledger.releaseHung();
    const [a, b] = await Promise.all([first, second]);

    expect(legCharges(SETUP_PREFIX)).toHaveLength(1);
    expect(legCharges(SEED_PREFIX)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(a.id).toBe(b.id);
  });

  it('holds no transaction while a Buzz charge is pending, and records both legs under one lock', async () => {
    ledger.queueFault('hang');
    const created = create(KEY);
    while (!ledger.isHung()) await settle();
    expect(locks.open()).toBe(0);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    ledger.releaseHung();
    await created;
    expect(locks.taken()).toEqual([LOCK]);
  });

  // The first charge spent the balance. The app's balance check would refuse the retry; the held
  // setup fee is found first and the seed is still checked and charged.
  it('a retry whose balance the setup fee spent resumes from it', async () => {
    ledger.setBalance(USER, SETUP_FEE + SEED);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(create(KEY)).rejects.toThrow();
    ledger.clearFaults();
    expect(ledger.balanceOf(USER)).toBe(SEED);

    await create(KEY);

    expect(legCharges(SETUP_PREFIX)).toHaveLength(1);
    expect(legCharges(SEED_PREFIX)).toHaveLength(1);
    expect(ledger.balanceOf(USER)).toBe(0);
  });

  it('a short balance with nothing held is refused before anything moves', async () => {
    ledger.setBalance(USER, SETUP_FEE + SEED - 1);

    await expect(create(KEY)).rejects.toThrow(/short/);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('a new creation (a new key) charges again', async () => {
    await create(KEY);
    await create(OTHER_KEY);

    expect(ledger.charges()).toHaveLength(4);
    expect(rows).toHaveLength(2);
  });
});

describe('a keyed crucible creation whose second leg fails', () => {
  // The setup fee is charged, the seed's outcome is unknown: nothing is refunded, and the retry
  // reuses the setup fee and settles the seed.
  it('an unknown seed outcome is "may have gone through" and resumes on the retry, each leg once', async () => {
    // The setup send answers; the seed send commits and its answer is lost; the resend fails.
    let sends = 0;
    buzz.createMultiAccountBuzzTransaction.mockImplementation(async (input) => {
      sends++;
      if (sends === 3) throw timeoutError();
      const sent = await ledger.createMultiAccountBuzzTransaction(input);
      if (sends === 2) throw timeoutError();
      return sent;
    });

    await expect(create(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(0);
    expect(rows).toHaveLength(0);

    const crucible = await create(KEY);

    expect(legCharges(SETUP_PREFIX)).toHaveLength(1);
    expect(legCharges(SEED_PREFIX)).toHaveLength(1);
    expect(crucible).toMatchObject({ status: CrucibleStatus.Active });
  });

  // The seed is refused (the ledger's own balance check, after the app's read a stale balance):
  // the setup fee is refunded under the key's lock, and the retry is refused as refunded.
  it('a refused seed refunds the setup fee, and the retry under the key is refused as refunded', async () => {
    ledger.setBalance(USER, SETUP_FEE);
    getUserBuzzAccount.mockResolvedValue([{ balance: 1_000_000, type: 'yellow' }]);

    await expect(create(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(legCharges(SETUP_PREFIX)).toHaveLength(1);
    expect(legCharges(SEED_PREFIX)).toHaveLength(0);
    expect(ledger.refunds()).toHaveLength(1);
    expect(locks.taken()).toEqual([LOCK]);
    expect(rows).toHaveLength(0);

    await expect(create(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
    expect(legCharges(SETUP_PREFIX)).toHaveLength(1);
  });
});

describe('a keyed crucible creation whose open fails', () => {
  it('refunds both legs with one bounded attempt each, deletes the row, refuses the retry as refunded', async () => {
    crucibleUpdate.mockRejectedValueOnce(new Error('write failed'));

    await expect(create(KEY)).rejects.toThrow('write failed');
    expect(ledger.refunds()).toHaveLength(2);
    for (const [, opts] of buzz.refundMultiAccountTransaction.mock.calls)
      expect(opts).toEqual({ timeoutMs: 10_000, retries: 0 });
    expect(rows).toHaveLength(0);

    await expect(create(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
  });

  // The lock's transaction must outlive every refund it started: a refund still in flight after the
  // lock is released can land on a charge a same-key request records meanwhile.
  it('one leg refund failing fast keeps the lock held until the other leg refund settles', async () => {
    crucibleUpdate.mockRejectedValueOnce(new Error('write failed'));
    let releaseSeed: () => void = () => undefined;
    let seedPending = false;
    buzz.refundMultiAccountTransaction.mockImplementation(
      async (input: { externalTransactionIdPrefix: string }) => {
        if (input.externalTransactionIdPrefix === SETUP_PREFIX) throw new Error('buzz down');
        seedPending = true;
        await new Promise<void>((resolve) => (releaseSeed = resolve));
        return ledger.refundMultiAccountTransaction(input);
      }
    );

    const outcome = create(KEY).catch((e: unknown) => e);
    while (!seedPending) await settle();
    await settle();
    await settle();

    expect(locks.open()).toBe(1);
    releaseSeed();
    expect(await outcome).toMatchObject({ message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
    expect(locks.open()).toBe(0);
  });

  // The open failed and only the setup refund landed. The retry finds the setup fee refunded: before
  // it is refused, the seed still charged is refunded too, rather than left charged for good.
  it('a retry after a refund that reached one leg refunds the leg still charged', async () => {
    crucibleUpdate.mockRejectedValueOnce(new Error('write failed'));
    let seedRefundFailed = false;
    buzz.refundMultiAccountTransaction.mockImplementation(
      async (input: { externalTransactionIdPrefix: string }) => {
        if (input.externalTransactionIdPrefix === SEED_PREFIX && !seedRefundFailed) {
          seedRefundFailed = true;
          throw new Error('buzz down');
        }
        return ledger.refundMultiAccountTransaction(input);
      }
    );

    await expect(create(KEY)).rejects.toMatchObject({ message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE });
    expect(ledger.refunds()).toHaveLength(1);

    await expect(create(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(2);
    const legsLeft = await ledger.getPrefixRefundState(SEED_PREFIX);
    expect(legsLeft.missing).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  // A leg refunded while the open waited for the lock refuses the open; the leg still charged is
  // refunded under the same lock first.
  it('an open refused for a leg refunded meanwhile refunds the other leg too', async () => {
    locks.onNextLock(async () => {
      await ledger.refundMultiAccountTransaction({ externalTransactionIdPrefix: SETUP_PREFIX });
    });

    await expect(create(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(2);
    expect(opened()).toHaveLength(0);
  });

  it('no pooled connection for the open is "may have gone through", with no refund', async () => {
    dbMock.dbWrite.$transaction.mockImplementationOnce((() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: 'test' })
      )) as never);

    await expect(create(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(0);

    await create(KEY);
    expect(ledger.charges()).toHaveLength(2);
    expect(opened()).toHaveLength(1);
  });
});

describe('a crucible creation without a key', () => {
  it('charges each leg under a new prefix per call and takes no lock, as before', async () => {
    let clock = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
    await create();
    await create();
    now.mockRestore();

    const ids = ledger.charges().map((c) => c.externalTransactionId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(new RegExp(`^crucible-(setup|seed)-${USER}-\\d+-0$`));
    expect(buzz.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
    expect(locks.taken()).toEqual([]);
    expect(rows).toHaveLength(2);
  });
});
