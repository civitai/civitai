import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as PrefixRefund from '~/server/services/buzz-prefix-refund';
import type * as PostService from '~/server/services/post.service';
import type * as NotificationService from '~/server/services/notification.service';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { createFakeBuzzLedger } from './buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from './charge-lock.fake';

/**
 * A crucible entry fee whose charge ends with an unknown outcome (the ledger committed, the
 * response was lost) must charge once across the entrant's retry, save the entry (and add its fee
 * to the pool) once, and tell the entrant it may have gone through when a resend cannot settle it.
 */

const { buzz, prefixRefund, getUserBuzzAccount, createNotification } = vi.hoisted(() => ({
  buzz: {
    createMultiAccountBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    getTransactionByExternalId: vi.fn(),
  },
  prefixRefund: { getPrefixRefundState: vi.fn() },
  getUserBuzzAccount: vi.fn(),
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
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostPublish: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

import { dbMock, redisMock } from '~/__tests__/mocks';

const { submitEntry } = await import('~/server/services/crucible.service');

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';
const USER = 42;
const CRUCIBLE_ID = 1;
const IMAGE_ID = 7;
const OTHER_IMAGE_ID = 8;
const FEE = 50;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const PREFIX = `crucible-entry-k-${USER}-${CRUCIBLE_ID}-${IMAGE_ID}-${KEY}`;
const STARTED_AT = new Date(Date.now() - 60 * 60_000);

type EntryRow = {
  id: number;
  crucibleId: number;
  userId: number;
  imageId: number;
  buzzTransactionId: string | null;
  user: { username: string };
};

let ledger: ReturnType<typeof createFakeBuzzLedger>;
let entries: EntryRow[];
let pool: number;
let locks = createFakeAdvisoryLocks();

const enter = (idempotencyKey?: string, imageId = IMAGE_ID) =>
  submitEntry({ crucibleId: CRUCIBLE_ID, imageId, userId: USER, idempotencyKey });

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.set.mockResolvedValue('OK');
  createNotification.mockResolvedValue(undefined);
  dbMock.dbRead.crucible.findUnique.mockResolvedValue({
    id: CRUCIBLE_ID,
    name: 'Test Crucible',
    userId: 99,
    status: CrucibleStatus.Active,
    buzzType: 'yellow',
    nsfwLevel: 1,
    contentType: MediaType.image,
    entryFee: FEE,
    entryLimit: 5,
    freeEntriesPerUser: 0,
    maxTotalEntries: null,
    minViewSeconds: null,
    maxClipSeconds: null,
    allowedResources: null,
    allowedBaseModels: [],
    startAt: STARTED_AT,
    createdAt: STARTED_AT,
    endAt: new Date(Date.now() + 60 * 60_000),
    ingestion: 'Scanned',
    textNsfw: false,
    image: { ingestion: 'Scanned' },
    _count: { entries: 0 },
  } as never);
  dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
  dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
  dbMock.dbRead.image.findUnique.mockImplementation((async (args: { where: { id: number } }) => ({
    id: args.where.id,
    userId: USER,
    type: MediaType.image,
    nsfwLevel: 1,
    metadata: null,
    ingestion: 'Scanned',
    createdAt: new Date(STARTED_AT.getTime() + 60_000),
  })) as never);
  dbMock.dbRead.image.count.mockResolvedValue(1);
  getUserBuzzAccount.mockImplementation(async () => [{ balance: ledger.balanceOf(USER) }]);

  entries = [];
  pool = 0;
  // The locked check that the crucible is still open, which also adds the fee to the pool.
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (strings.join('').includes('"prizePool"')) pool += values[0] as number;
    return 1;
  }) as never);
  dbMock.dbWrite.crucibleEntry.create.mockImplementation((async (args: {
    data: Omit<EntryRow, 'id' | 'user'>;
  }) => {
    const row = { id: entries.length + 1, ...args.data, user: { username: 'tester' } };
    entries.push(row);
    return row;
  }) as never);
  dbMock.dbWrite.crucibleEntry.findFirst.mockImplementation(
    (async (args: { where: { crucibleId: number; userId: number; buzzTransactionId: string } }) =>
      entries.find(
        (e) =>
          e.crucibleId === args.where.crucibleId &&
          e.userId === args.where.userId &&
          e.buzzTransactionId === args.where.buzzTransactionId
      ) ?? null) as never
  );

  locks = createFakeAdvisoryLocks();
  dbMock.dbWrite.$transaction.mockImplementation(((
    cb: (tx: unknown) => Promise<unknown>,
    options?: { timeout?: number }
  ) =>
    locks.transaction(
      cb,
      {
        $executeRaw: (...args: unknown[]) => dbMock.dbWrite.$executeRaw(...(args as [never])),
        post: { updateMany: (args: unknown) => dbMock.dbWrite.post.updateMany(args as never) },
        crucibleEntry: {
          create: (args: unknown) => dbMock.dbWrite.crucibleEntry.create(args as never),
          findFirst: (args: unknown) => dbMock.dbWrite.crucibleEntry.findFirst(args as never),
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

describe('a crucible entry fee across an unknown outcome', () => {
  it('a retry with the same key after an unanswered charge charges once and enters once', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(enter(KEY)).rejects.toThrow();
    ledger.clearFaults();
    expect(entries).toHaveLength(0);

    await enter(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].amount).toBe(FEE);
    expect(entries).toHaveLength(1);
    expect(pool).toBe(FEE);
  });

  it('saves the entry in the same request when the resend answers', async () => {
    ledger.queueFault('lose-response');

    await enter(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].buzzTransactionId).toBe(PREFIX);
  });

  it('answers "may have gone through" when the resend also fails, and saves nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await enter(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(entries).toHaveLength(0);
    expect(pool).toBe(0);
    expect(ledger.refunds()).toHaveLength(0);
  });

  it('a lookup that fails before charging is "may have gone through", and charges nothing', async () => {
    ledger.failLookups();

    await expect(enter(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(ledger.charges()).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  // The first charge landed and spent the balance. The app's own balance check would refuse the
  // retry as "insufficient funds" (releasing the client's key); the held charge is found first.
  it('a retry whose balance the first charge spent enters from that charge', async () => {
    ledger.setBalance(USER, FEE);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(enter(KEY)).rejects.toThrow();
    ledger.clearFaults();
    expect(ledger.balanceOf(USER)).toBe(0);

    await enter(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });

  it('a short balance with nothing held is still refused before charging', async () => {
    ledger.setBalance(USER, FEE - 1);

    await expect(enter(KEY)).rejects.toThrow(/short/);
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('a retry after the entry was saved (response lost) answers with it, charges nothing more, notifies once', async () => {
    const first = await enter(KEY);
    // The replica has not seen the entry yet, so the image-already-entered check passes.
    const again = await enter(KEY);

    expect(again).toEqual(first);
    expect(ledger.charges()).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(pool).toBe(FEE);
    // The creator heard about the entry from the request that saved it, once.
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  // The user id in the prefix is what keeps one entrant's key from naming another's charge.
  it("another entrant's request under the same key is charged on its own", async () => {
    await enter(KEY);
    // The same image id, owned by the other entrant (as far as this fixture can tell).
    const owned = await dbMock.dbRead.image.findUnique({ where: { id: IMAGE_ID } } as never);
    dbMock.dbRead.image.findUnique.mockResolvedValueOnce({ ...owned, userId: USER + 1 } as never);
    await submitEntry({
      crucibleId: CRUCIBLE_ID,
      imageId: IMAGE_ID,
      userId: USER + 1,
      idempotencyKey: KEY,
    });

    expect(ledger.charges().map((c) => c.fromAccountId)).toEqual([USER, USER + 1]);
    expect(entries.map((e) => e.userId)).toEqual([USER, USER + 1]);
  });

  it('refuses to save on a charge that was refunded, so the client starts over', async () => {
    dbMock.dbWrite.crucibleEntry.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(enter(KEY)).rejects.toThrow('write failed');
    expect(ledger.refunds()).toHaveLength(1);

    const error = await enter(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: PAYMENT_REFUNDED_MESSAGE });
    expect(entries).toHaveLength(0);
  });

  it('refuses to save on a charge refunded while it waited for the lock', async () => {
    locks.onNextLock(async () => {
      await ledger.refundMultiAccountTransaction({ externalTransactionIdPrefix: PREFIX });
    });

    await expect(enter(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
    expect(entries).toHaveLength(0);
  });

  it('refunds the fee of an entry the closing crucible refused, with one bounded attempt', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0 as never);

    await expect(enter(KEY)).rejects.toThrow(/not accepting entries|closed/);

    expect(entries).toHaveLength(0);
    expect(ledger.refunds()).toHaveLength(1);
    expect(buzz.refundMultiAccountTransaction.mock.calls[0][1]).toEqual({
      timeoutMs: 10_000,
      retries: 0,
    });
  });

  // A refusal at the cutoff is routine, and a retry is then refused before it reaches the charge,
  // so one failed refund attempt must not leave the fee held.
  it('a refund that fails once after a refused entry is retried: refunded, nothing saved', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0 as never);
    buzz.refundMultiAccountTransaction.mockRejectedValueOnce(new Error('buzz down'));

    await expect(enter(KEY)).rejects.toThrow(/not accepting entries|closed/);

    expect(buzz.refundMultiAccountTransaction).toHaveBeenCalledTimes(2);
    expect(ledger.refunds()).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  // The first charge spent the balance and the retry's lookup has not seen it yet, so the app's
  // balance check refuses. The charge is looked up again before that refusal stands.
  // Listings: one before charging, then up to four re-reads after the refusal (three retry delays).
  // Three hidden: the lookup before charging and the first two re-reads miss, the third finds it.
  it('a retry refused for balance while its earlier charge is held continues from that charge', async () => {
    ledger.setBalance(USER, FEE);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(enter(KEY)).rejects.toThrow();
    ledger.clearFaults();
    buzz.getMultiAccountTransactionsByPrefix.mockClear();
    ledger.hideNextLookups(3);

    await enter(KEY);

    expect(buzz.getMultiAccountTransactionsByPrefix).toHaveBeenCalledTimes(4);
    expect(ledger.charges()).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(pool).toBe(FEE);
  });

  // Five hidden: the lookup before charging and all four re-reads miss, so the refusal stands.
  // An ACCEPTED LIMITATION, pinned so it stays visible: a ledger read that lags past the whole
  // re-read window leaves the earlier charge held and unrecorded. A fix that continues from it
  // changes this test on purpose; it is not a regression.
  it('accepted limitation: a balance refusal stands when every re-read after it misses the held charge', async () => {
    ledger.setBalance(USER, FEE);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(enter(KEY)).rejects.toThrow();
    ledger.clearFaults();
    buzz.getMultiAccountTransactionsByPrefix.mockClear();
    ledger.hideNextLookups(5);

    await expect(enter(KEY)).rejects.toThrow(/short/);

    expect(buzz.getMultiAccountTransactionsByPrefix).toHaveBeenCalledTimes(5);
    expect(ledger.charges()).toHaveLength(1);
    expect(entries).toHaveLength(0);
    expect(pool).toBe(0);
  });

  it('a new entry (a new key) charges again', async () => {
    await enter(KEY);
    await enter(OTHER_KEY, OTHER_IMAGE_ID);

    expect(ledger.charges()).toHaveLength(2);
    expect(entries).toHaveLength(2);
  });

  it('a key reused for a different image is a different fee, charged on its own', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await enter(KEY).catch(() => undefined);
    ledger.clearFaults();

    await enter(KEY, OTHER_IMAGE_ID);

    expect(ledger.charges()).toHaveLength(2);
    expect(entries).toEqual([expect.objectContaining({ imageId: OTHER_IMAGE_ID })]);
  });

  it('files the fee under the user, the crucible and the image, then the key', async () => {
    await enter(KEY);
    expect(ledger.charges().map((c) => c.externalTransactionId)).toEqual([`${PREFIX}-0`]);
  });

  // The ledger answers a held prefix with what it holds, whatever amount was sent. The creator
  // changed the fee after the first attempt charged it: the retry must not save an entry priced
  // at the new fee on the old fee's money.
  it('a retry under the same key for a different fee is refused, and saves nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(enter(KEY)).rejects.toThrow();
    ledger.clearFaults();
    const crucible = await dbMock.dbRead.crucible.findUnique({
      where: { id: CRUCIBLE_ID },
    } as never);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucible,
      entryFee: FEE + 30,
    } as never);

    await expect(enter(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This payment was already started with different details. Please start it again.',
    });
    expect(ledger.charges().map((c) => c.amount)).toEqual([FEE]);
    expect(entries).toHaveLength(0);
    expect(pool).toBe(0);
  });

  it('takes the lock on the fee prefix', async () => {
    await enter(KEY);
    expect(locks.taken()).toEqual([PREFIX]);
  });

  it('holds no transaction while the Buzz charge is pending', async () => {
    ledger.queueFault('hang');
    const entered = enter(KEY);
    while (!ledger.isHung()) await settle();
    expect(locks.open()).toBe(0);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    ledger.releaseHung();
    await entered;
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
  });

  // The per-user submit lock in Redis stops a second request; past its expiry (a charge slower than
  // it) the key's advisory lock still records the one charge once.
  it('two requests with one key in flight: one charge, one entry', async () => {
    ledger.queueFault('hang');
    const first = enter(KEY);
    await settle();
    const second = enter(KEY);
    await settle();
    ledger.releaseHung();
    const [a, b] = await Promise.all([first, second]);

    expect(ledger.charges()).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(pool).toBe(FEE);
    expect(a).toEqual(b);
  });

  it('while another submit holds the per-user lock, a keyed submit is told to wait with a 429', async () => {
    redisMock.sysRedis.set.mockResolvedValueOnce(null);

    await expect(enter(KEY)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('no pooled connection for the save is "may have gone through", with no refund', async () => {
    dbMock.dbWrite.$transaction.mockImplementationOnce((() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: 'test' })
      )) as never);

    await expect(enter(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(0);

    await enter(KEY);
    expect(ledger.charges()).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });
});

describe('a crucible entry fee without a key', () => {
  it('is charged under a new prefix per call and the lock refusal stays a 400, as before', async () => {
    // Each attempt is a later moment, as it is for an entrant pressing submit again.
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
    await enter();
    await enter(undefined, OTHER_IMAGE_ID);

    const ids = ledger.charges().map((c) => c.externalTransactionId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(new RegExp(`^crucible-entry-${CRUCIBLE_ID}-${USER}-`));
    expect(buzz.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
    expect(locks.taken()).toEqual([]);

    redisMock.sysRedis.set.mockResolvedValueOnce(null);
    await expect(enter()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
