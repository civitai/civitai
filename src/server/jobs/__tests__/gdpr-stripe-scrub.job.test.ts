import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The sweep that brings a deleted account's Stripe state up to the one-time backfill's, then drops
 * our `customerId` pointer. The pointer is the only route back to those Stripe records, so it may
 * be dropped only once every step for that account is terminal — and never for an account the
 * backfill already covered, which is what the floor is for.
 */

const { scrubStripeAccount } = vi.hoisted(() => ({ scrubStripeAccount: vi.fn() }));

vi.mock('~/server/services/gdpr/stripe-account-scrub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/services/gdpr/stripe-account-scrub')>()),
  scrubStripeAccount,
}));

import {
  GDPR_STRIPE_SCRUB_FLOOR,
  gdprStripeScrubJob,
  isDue,
} from '~/server/jobs/gdpr-stripe-scrub';

const USER_ID = 42;
const CUSTOMER = 'cus_live1';

const complete = (overrides = {}) => ({
  complete: true,
  customerGone: false,
  cleared: { paymentMethods: 0, charges: 0, paymentIntents: 0 },
  blocked: [],
  canceledSubscriptions: [],
  errors: [],
  ...overrides,
});

const runJob = () => gdprStripeScrubJob.run({}).result;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findMany.mockResolvedValue([{ id: USER_ID, customerId: CUSTOMER, meta: {} }]);
  dbMock.dbWrite.user.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.user.update.mockResolvedValue({});
  scrubStripeAccount.mockResolvedValue(complete());
});

describe('gdpr-stripe-scrub — what it selects', () => {
  it('takes only accounts deleted after the backfill snapshot', async () => {
    await runJob();

    const [args] = dbMock.dbWrite.user.findMany.mock.calls[0];
    expect(args.where.deletedAt).toEqual({ gte: GDPR_STRIPE_SCRUB_FLOOR });
    expect(args.where.customerId).toEqual({ startsWith: 'cus_' });
    // Everything before the floor belongs to the one-time purge, which is bounded by membership
    // of the scrubbed list and needs its own approval. This job must not become that by proxy.
    expect(GDPR_STRIPE_SCRUB_FLOOR.toISOString()).toBe('2026-09-18T22:40:00.000Z');
  });

  it('sends the floor as a Date, so no offset can be dropped in a cast', async () => {
    await runJob();

    const [args] = dbMock.dbWrite.user.findMany.mock.calls[0];
    // `User.deletedAt` is timestamp WITHOUT time zone and holds UTC. Postgres drops the offset of
    // a literal that carries one, silently meaning a different instant.
    expect(args.where.deletedAt.gte).toBeInstanceOf(Date);
    expect(args.where.deletedAt.gte.getTime()).toBe(Date.UTC(2026, 8, 18, 22, 40, 0));
  });

  it('skips a customerId that is not a Stripe id, without stripping anything', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      { id: 1, customerId: 'cus_NL1pYvDpkPS6fN_MERGED', meta: {} },
      { id: 2, customerId: CUSTOMER, meta: {} },
    ]);

    const summary = (await runJob()) as { processed: number };

    expect(scrubStripeAccount).toHaveBeenCalledTimes(1);
    expect(scrubStripeAccount).toHaveBeenCalledWith({ userId: 2, customerId: CUSTOMER });
    expect(summary.processed).toBe(1);
  });

  it('processes at most one batch per run', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue(
      Array.from({ length: 80 }, (_, i) => ({ id: i + 1, customerId: `cus_${i}`, meta: {} }))
    );

    const summary = (await runJob()) as { processed: number };

    expect(summary.processed).toBe(25);
    expect(dbMock.dbWrite.user.findMany.mock.calls[0][0].take).toBe(100);
  });
});

describe('gdpr-stripe-scrub — dropping the pointer', () => {
  it('nulls customerId only through a guarded update, and clears the retry state', async () => {
    await runJob();

    expect(dbMock.dbWrite.user.updateMany).toHaveBeenCalledWith({
      // The guard is what makes a restore between the read and this write safe, and what stops a
      // second run nulling a pointer it did not scrub.
      where: { id: USER_ID, deletedAt: { not: null }, customerId: CUSTOMER },
      data: { customerId: null, meta: {} },
    });
  });

  it('keeps customerId when any step failed', async () => {
    scrubStripeAccount.mockResolvedValue(
      complete({ complete: false, errors: [{ step: 'customer', message: 'stripe down' }] })
    );

    const summary = (await runJob()) as { failed: number; scrubbed: number };

    // The pointer IS the queue. Dropping it here would lose the account for good.
    expect(dbMock.dbWrite.user.updateMany).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ failed: 1, scrubbed: 0 });
  });

  it('keeps customerId when the scrub throws outright', async () => {
    scrubStripeAccount.mockRejectedValue(new Error('stripe down'));

    const summary = (await runJob()) as { failed: number };

    expect(dbMock.dbWrite.user.updateMany).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });

  it('drops the pointer for an account that is gone from Stripe', async () => {
    scrubStripeAccount.mockResolvedValue(complete({ customerGone: true }));

    await runJob();

    expect(dbMock.dbWrite.user.updateMany).toHaveBeenCalled();
  });

  it('drops the pointer when a payment method is blocked, and counts it', async () => {
    scrubStripeAccount.mockResolvedValue(
      complete({ blocked: [{ id: 'pm_dead', code: 'card_declined', detached: true }] })
    );

    const summary = (await runJob()) as { blocked: number; scrubbed: number };

    // Blocked is terminal: the card declines and will decline forever. Retrying it every pass
    // would mean the account is never finished.
    expect(summary).toMatchObject({ blocked: 1, scrubbed: 1 });
  });

  it('does not count a guarded update that matched nothing', async () => {
    dbMock.dbWrite.user.updateMany.mockResolvedValue({ count: 0 });

    const summary = (await runJob()) as { scrubbed: number };

    expect(summary.scrubbed).toBe(0);
  });
});

describe('gdpr-stripe-scrub — retry state', () => {
  it('records the attempt and the error on failure', async () => {
    scrubStripeAccount.mockResolvedValue(
      complete({ complete: false, errors: [{ step: 'customer', message: 'stripe down' }] })
    );

    await runJob();

    const [args] = dbMock.dbWrite.user.update.mock.calls[0];
    expect(args.where).toEqual({ id: USER_ID });
    expect(args.data.meta.gdprStripeScrub).toMatchObject({ attempts: 1, lastError: 'stripe down' });
  });

  it('keeps the rest of meta when it records an attempt', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      { id: USER_ID, customerId: CUSTOMER, meta: { imageRemoval: 'grace' } },
    ]);
    scrubStripeAccount.mockResolvedValue(complete({ complete: false, errors: [] }));

    await runJob();

    expect(dbMock.dbWrite.user.update.mock.calls[0][0].data.meta).toMatchObject({
      imageRemoval: 'grace',
    });
  });

  it('alerts once an account has failed long enough to need a person', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      {
        id: USER_ID,
        customerId: CUSTOMER,
        meta: { gdprStripeScrub: { attempts: 7, lastAttemptAt: '2020-01-01T00:00:00.000Z' } },
      },
    ]);
    scrubStripeAccount.mockResolvedValue(
      complete({ complete: false, errors: [{ step: 'customer', message: 'stripe down' }] })
    );

    await runJob();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gdpr-stripe-scrub-stuck', type: 'error', userId: USER_ID })
    );
  });

  it('does not alert on an ordinary first failure', async () => {
    scrubStripeAccount.mockResolvedValue(complete({ complete: false, errors: [] }));

    await runJob();

    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gdpr-stripe-scrub-stuck' })
    );
  });

  it('holds a failed account back, then lets it through when its backoff expires', async () => {
    const now = new Date('2026-09-21T12:00:00Z');
    const justTried = { attempts: 1, lastAttemptAt: '2026-09-21T11:59:00.000Z' };
    const longAgo = { attempts: 1, lastAttemptAt: '2026-09-21T11:50:00.000Z' };

    expect(isDue(justTried, now)).toBe(false);
    expect(isDue(longAgo, now)).toBe(true);
    expect(isDue(undefined, now)).toBe(true);
    // A larger attempt count waits longer, so one poisoned account cannot eat every run.
    expect(isDue({ attempts: 5, lastAttemptAt: longAgo.lastAttemptAt }, now)).toBe(false);
  });

  it('skips a held-back account without calling Stripe', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      {
        id: USER_ID,
        customerId: CUSTOMER,
        meta: { gdprStripeScrub: { attempts: 3, lastAttemptAt: new Date().toISOString() } },
      },
    ]);

    const summary = (await runJob()) as { processed: number; considered: number };

    expect(scrubStripeAccount).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ processed: 0, considered: 1 });
  });
});
