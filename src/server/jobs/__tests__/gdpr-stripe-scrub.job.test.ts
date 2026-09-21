import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as AccountScrub from '~/server/services/gdpr/stripe-account-scrub';

/**
 * The sweep that brings a deleted account's Stripe state up to the one-time pass's, then drops our
 * `customerId` pointer. That pointer is the only route back to those Stripe records, so it may go
 * only once every step for the account is terminal.
 */

const { scrubStripeAccount } = vi.hoisted(() => ({
  scrubStripeAccount: vi.fn<typeof AccountScrub.scrubStripeAccount>(),
}));

// importOriginal, so CUSTOMER_ID_SHAPE stays the real regex the service enforces: the job's
// malformed-id filter is then pinned against the same rule rather than a copy of it.
vi.mock('~/server/services/gdpr/stripe-account-scrub', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountScrub>()),
  scrubStripeAccount,
}));

import { gdprStripeScrubJob, isDue } from '~/server/jobs/gdpr-stripe-scrub';

const USER_ID = 42;
const CUSTOMER = 'cus_live1';

const complete = (overrides: Partial<AccountScrub.ScrubOutcome> = {}) =>
  ({
    complete: true,
    customerGone: false,
    pending: false,
    cleared: { paymentMethods: 0, charges: 0, paymentIntents: 0 },
    blocked: [],
    canceledSubscriptions: [],
    errors: [],
    ...overrides,
  } as AccountScrub.ScrubOutcome);

const runJob = () => gdprStripeScrubJob.run({}).result;

/** What the PRIMARY returns for the eligibility re-read plus the meta read, in one object. */
const live = (meta: Record<string, unknown> = {}) => ({
  deletedAt: new Date('2026-09-01T00:00:00Z'),
  customerId: CUSTOMER,
  meta,
});

afterEach(() => {
  // Not inline at the end of the one test that uses them: a test appended after it would inherit
  // frozen time, and this file stamps lastAttemptAt from the clock.
  vi.useRealTimers();
});

/** The primary agrees with whatever the replica selected, for a many-account fixture. */
const liveForAny = () =>
  dbMock.dbWrite.user.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => ({
      ...live(),
      customerId: `cus_${where.id - 1}`,
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.user.findMany.mockResolvedValue([{ id: USER_ID, customerId: CUSTOMER, meta: {} }]);
  dbMock.dbWrite.user.findUnique.mockResolvedValue(live());
  dbMock.dbWrite.user.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.user.update.mockResolvedValue({});
  scrubStripeAccount.mockResolvedValue(complete());
});

describe('gdpr-stripe-scrub — what it selects', () => {
  it('selects by STATE, with no cutoff date', async () => {
    await runJob();

    const [args] = dbMock.dbRead.user.findMany.mock.calls[0];
    expect(args.where.deletedAt).toMatchObject({ not: null });
    expect(args.where.customerId).toEqual({ not: null });
    // 🔴 Do not reintroduce a start date. A draft carried one at 2026-09-18 22:40 UTC to keep the
    // job off the accounts the one-time pass had done; that pass has since run, and the date was
    // measured to STRAND 2 accounts it never covered, both still holding an email at Stripe.
    // The SHAPE, not a spelling: a floor could come back as `NOT: { deletedAt: { lt: FLOOR } }`
    // and a substring check would miss it. These two keys are also what makes the partial index
    // usable, since its predicate is customerId IS NOT NULL AND deletedAt IS NOT NULL.
    expect(Object.keys(args.where.deletedAt).sort()).toEqual(['lte', 'not']);
    expect(Object.keys(args.where).sort()).toEqual(['customerId', 'deletedAt']);
  });

  it('an account becomes eligible as it AGES — this is a delay, never a floor', async () => {
    await runJob();

    // Our own cancel's customer.subscription.deleted is resolved BY customerId, and the webhook
    // throws when it cannot find the user. Waiting lets it land while the pointer still resolves,
    // which is why the webhook itself needed no change.
    const { lte } = dbMock.dbRead.user.findMany.mock.calls[0][0].where.deletedAt;
    expect(lte).toBeInstanceOf(Date);
    const delay = Date.now() - lte.getTime();
    expect(delay).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(delay).toBeLessThan(16 * 60 * 1000);
  });

  it('reads a window several batches wide, so held-back accounts do not fill it', async () => {
    await runJob();

    const [args] = dbMock.dbRead.user.findMany.mock.calls[0];
    expect(args.orderBy).toEqual({ deletedAt: 'asc' });
    // The expensive query stays off the primary; the writes stay on it.
    expect(dbMock.dbWrite.user.findMany).not.toHaveBeenCalled();
    expect(args.take).toBeGreaterThan(25 * 2);
  });

  it('skips a customerId that is not a Stripe id, without stripping anything, and counts it', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([
      // Both shapes exist in prod: a `_MERGED` suffix and an empty string. The suffix must never
      // be stripped — the base id resolves to a customer whose owner could not be established.
      { id: 1, customerId: 'cus_example_MERGED', meta: {} },
      { id: 2, customerId: '', meta: {} },
      { id: 3, customerId: CUSTOMER, meta: {} },
    ]);

    const summary = (await runJob()) as { processed: number; malformed: number };

    expect(scrubStripeAccount).toHaveBeenCalledTimes(1);
    expect(scrubStripeAccount).toHaveBeenCalledWith({ customerId: CUSTOMER });
    expect(summary).toMatchObject({ processed: 1, malformed: 2 });
  });

  it('processes at most one batch per run', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue(
      Array.from({ length: 80 }, (_, i) => ({ id: i + 1, customerId: `cus_${i}`, meta: {} }))
    );
    liveForAny();

    const summary = (await runJob()) as { processed: number };

    expect(summary.processed).toBe(25);
  });
});

describe('gdpr-stripe-scrub — dropping the pointer', () => {
  it('nulls customerId only through a guarded update, and clears only the retry state', async () => {
    // A fixture that tells the fix from an identity function: the retry state must go and the
    // rest of meta must survive.
    dbMock.dbWrite.user.findUnique.mockResolvedValue(
      live({
        imageRemoval: 'grace',
        gdprStripeScrub: { attempts: 3, lastAttemptAt: '2020-01-01T00:00:00.000Z' },
      })
    );

    await runJob();

    expect(dbMock.dbWrite.user.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.user.updateMany).toHaveBeenCalledWith({
      // The guard makes a restore between the read and this write safe, and stops a second run
      // nulling a pointer it did not scrub.
      where: { id: USER_ID, deletedAt: { not: null }, customerId: CUSTOMER },
      data: { customerId: null, meta: { imageRemoval: 'grace' } },
    });
  });

  it('re-reads meta rather than writing back the copy it selected with', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([
      { id: USER_ID, customerId: CUSTOMER, meta: { imageRemoval: 'grace' } },
    ]);
    // Written by something else while the scrub was busy with Stripe. The whole object is
    // replaced here, so a stale copy would silently undo it.
    dbMock.dbWrite.user.findUnique.mockResolvedValue(live({ imageRemoval: 'immediate' }));

    await runJob();

    expect(dbMock.dbWrite.user.updateMany.mock.calls[0][0].data.meta).toEqual({
      imageRemoval: 'immediate',
    });
  });

  it.each([
    [
      'a step failed',
      complete({ complete: false, errors: [{ step: 'customer', message: 'down' }] }),
    ],
    ['work is pending', complete({ complete: false, pending: true, errors: [] })],
  ])('keeps customerId when %s', async (_, outcome) => {
    scrubStripeAccount.mockResolvedValue(outcome);

    const summary = (await runJob()) as { failed: number; scrubbed: number };

    // The pointer IS the queue. Dropping it here would lose the account for good.
    expect(dbMock.dbWrite.user.updateMany).not.toHaveBeenCalled();
    expect(summary.scrubbed).toBe(0);
  });

  it('counts a waiting account as pending, not failed, and does not alert on it', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(
      live({ gdprStripeScrub: { attempts: 9, lastAttemptAt: '2020-01-01T00:00:00.000Z' } })
    );
    scrubStripeAccount.mockResolvedValue(complete({ complete: false, pending: true, errors: [] }));

    const summary = (await runJob()) as { pending: number; failed: number };

    // It is waiting on its own payment, not on us. Alerting here would page someone with no step
    // and no message to act on.
    expect(summary).toMatchObject({ pending: 1, failed: 0 });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gdpr-stripe-scrub-stuck' })
    );
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

    // Blocked is terminal: the card declines and always will. Retrying it every pass would mean
    // the account is never finished.
    expect(summary).toMatchObject({ blocked: 1, scrubbed: 1 });
  });

  it('defers the pointer when THIS run cancelled a subscription', async () => {
    scrubStripeAccount.mockResolvedValue(complete({ canceledSubscriptions: ['sub_1'] }));

    const summary = (await runJob()) as { pending: number };

    // That cancel emits customer.subscription.deleted asynchronously, and the webhook resolves it
    // BY customerId. Dropping the pointer seconds later 400s it, and Stripe retries a 4xx for
    // days. The next run finds the subscription already canceled and finishes the account.
    expect(dbMock.dbWrite.user.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.update).toHaveBeenCalled();
    expect(summary.pending).toBe(1);
  });

  it('CONTROL: with nothing cancelled, the same outcome DOES drop the pointer', async () => {
    scrubStripeAccount.mockResolvedValue(complete({ canceledSubscriptions: [] }));

    await runJob();

    expect(dbMock.dbWrite.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it('skips an account the primary says is no longer eligible', async () => {
    // The selection reads a replica. A restore that has not replicated yet would otherwise be
    // cancelled, detached and stripped — none of which the guard on the final write can undo.
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ ...live(), deletedAt: null });

    const summary = (await runJob()) as { processed: number };

    expect(scrubStripeAccount).not.toHaveBeenCalled();
    expect(summary.processed).toBe(0);
  });

  it('skips an account whose pointer changed under the replica read', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ ...live(), customerId: 'cus_other' });

    await runJob();

    expect(scrubStripeAccount).not.toHaveBeenCalled();
  });

  it('does not count a guarded update that matched nothing', async () => {
    dbMock.dbWrite.user.updateMany.mockResolvedValue({ count: 0 });

    const summary = (await runJob()) as { scrubbed: number };

    expect(summary.scrubbed).toBe(0);
  });
});

describe('gdpr-stripe-scrub — the queue alert', () => {
  it('alerts when the window comes back full', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: i + 1, customerId: `cus_${i}`, meta: {} }))
    );

    await runJob();

    // A full window means newer deletions may not be visible at all — the only thing that tells a
    // blocked queue from an empty one.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gdpr-stripe-scrub-queue', type: 'error' })
    );
  });

  it('CONTROL: an ordinary run does not alert, malformed rows included', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([
      { id: 1, customerId: 'cus_example_MERGED', meta: {} },
      { id: 2, customerId: CUSTOMER, meta: {} },
    ]);

    await runJob();

    // The two malformed rows are permanent. Alerting on them would emit the same warning every
    // ten minutes forever, which is how a channel gets muted — taking the full-window error too.
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gdpr-stripe-scrub-queue' })
    );
  });
});

describe('gdpr-stripe-scrub — retry state', () => {
  it('records the attempt, the step and the error on failure', async () => {
    scrubStripeAccount.mockResolvedValue(
      complete({ complete: false, errors: [{ step: 'customer', message: 'stripe down' }] })
    );
    dbMock.dbWrite.user.findUnique.mockResolvedValue(live({ imageRemoval: 'grace' }));

    await runJob();

    const [args] = dbMock.dbWrite.user.update.mock.calls[0];
    expect(args.where).toEqual({ id: USER_ID });
    expect(args.data.meta).toMatchObject({
      imageRemoval: 'grace',
      gdprStripeScrub: { attempts: 1, lastError: 'stripe down' },
    });
  });

  it('alerts once an account has failed long enough to need a person, naming the step', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(
      live({ gdprStripeScrub: { attempts: 7, lastAttemptAt: '2020-01-01T00:00:00.000Z' } })
    );
    scrubStripeAccount.mockResolvedValue(
      complete({ complete: false, errors: [{ step: 'paymentMethod', message: 'stripe down' }] })
    );

    await runJob();

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'gdpr-stripe-scrub-stuck',
        type: 'error',
        userId: USER_ID,
        attempts: 8,
        // The step is what says whether this needs Stripe support or a code fix.
        step: 'paymentMethod',
      })
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
    // More attempts wait longer, so one poisoned account cannot eat every run.
    expect(isDue({ attempts: 5, lastAttemptAt: longAgo.lastAttemptAt }, now)).toBe(false);
  });

  it('skips a held-back account without calling Stripe', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([
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

  it('stops early rather than outrunning its own schedule', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: i + 1, customerId: `cus_${i}`, meta: {} }))
    );
    liveForAny();
    let processed = 0;
    scrubStripeAccount.mockImplementation(async () => {
      processed++;
      // Every account eats most of the budget, as a fully-degraded Stripe would: three attempts
      // at a 10s timeout each, per call, several calls per account.
      vi.setSystemTime(Date.now() + 3 * 60 * 1000);
      return complete();
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const startedAt = Date.now();

    const summary = (await runJob()) as { processed: number };
    const elapsed = Date.now() - startedAt;

    vi.useRealTimers();
    // The invariant is the cron interval, not a count: a budget of 15 minutes would still process
    // "few" accounts while stacking runs exactly as this exists to prevent.
    expect(elapsed).toBeLessThan(10 * 60 * 1000);
    expect(summary.processed).toBe(3);
    expect(processed).toBe(summary.processed);
  });
});
