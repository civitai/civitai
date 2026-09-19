import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userFollowsCache } from '~/server/redis/caches';

/**
 * Account deletion is a SOFT delete, so no FK cascade fires and nothing is removed for
 * free. Measured on prod before this change, across 1,330,849 deleted accounts:
 * 733,857 still carried `name`, 157,633 a Stripe `customerId`, 192,791 a UserProfile row.
 *
 * These assertions exist to keep that set scrubbed. If one fails, the account is leaking
 * personal data again — do not relax it without saying what replaced it.
 *
 * Scope: this covers NEW deletions only. The historical rows above are untouched by this
 * file and by the change it guards; they are the GDPR backfill's job. And `customerId` is
 * deliberately left in place here — see the webhook test below for why.
 */

import * as UserService from '~/server/services/user.service';

const USER_ID = 42;
const user = dbMock.dbWrite.user;

const deleteUser = () =>
  UserService.deleteUser({ id: USER_ID, username: 'gone' } as Parameters<
    typeof UserService.deleteUser
  >[0]);

/** The user.update carrying the payment-provider purge, as opposed to the soft-delete one. */
const paymentIdUpdate = () =>
  user.update.mock.calls.findIndex(
    ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.paddleCustomerId === null
  );

/**
 * The write paths this scan covers, named explicitly. `dbMock.dbWrite` is a proxy that
 * materialises delegates on access, so Object.keys() over it enumerates NOTHING — a scan
 * written that way returns [] for every input and the guard below passes forever. That was
 * tried; the CONTROL tests are what caught it. Add a path here if a new one appears.
 */
const WRITE_PATHS = [
  () => ['dbWrite.user.update', dbMock.dbWrite.user.update] as const,
  () => ['dbWrite.user.updateMany', dbMock.dbWrite.user.updateMany] as const,
  () => ['dbWrite.$executeRaw', dbMock.dbWrite.$executeRaw] as const,
  () => ['dbWrite.$executeRawUnsafe', dbMock.dbWrite.$executeRawUnsafe] as const,
  // UPDATE ... RETURNING goes through the query methods, and user.service.ts uses them.
  () => ['dbWrite.$queryRaw', dbMock.dbWrite.$queryRaw] as const,
  () => ['dbWrite.$queryRawUnsafe', dbMock.dbWrite.$queryRawUnsafe] as const,
  () => ['dbWrite.user.upsert', dbMock.dbWrite.user.upsert] as const,
];
// NOT covered: pgDbWrite, and any `tx.*` write inside an interactive $transaction callback —
// these tests mock $transaction to return its argument unrun, so such writes are never recorded.

/** Labels of the covered dbWrite calls whose arguments mention `needle`. */
const dbWriteCallsMentioning = (needle: string) => {
  const hits: string[] = [];
  for (const get of WRITE_PATHS) {
    const [label, fn] = get();
    const calls = (fn as unknown as { mock?: { calls?: unknown[][] } })?.mock?.calls ?? [];
    for (const call of calls) {
      let serialized: string;
      try {
        serialized = JSON.stringify(call) ?? String(call);
      } catch {
        serialized = String(call);
      }
      if (serialized.includes(needle)) hits.push(label);
    }
  }
  return hits;
};

/** The data object of the soft-delete update (the one inside the transaction). */
const softDeleteData = () => {
  const call = user.update.mock.calls.find(
    ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.deletedAt !== undefined
  );
  return (call?.[0] as { data: Record<string, unknown> }).data;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: USER_ID, meta: {} });
  dbMock.dbWrite.user.update.mockResolvedValue({});
  dbMock.dbWrite.model.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.account.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.session.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userEngagement.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userProfile.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.userLink.deleteMany.mockResolvedValue({ count: 0 });
  dbMock.dbWrite.$transaction.mockImplementation(async (ops: unknown) => ops);
  vi.spyOn(userFollowsCache, 'bust').mockResolvedValue(undefined);
});

describe('deleteUser — what the soft delete scrubs', () => {
  it('nulls the provider-supplied name', async () => {
    await deleteUser();

    // 733,857 deleted accounts carried one, ~490k shaped "First Last". Nothing displays
    // it, so a survivor is pure retained PII.
    expect(softDeleteData().name).toBeNull();
  });

  it('deletes the UserProfile row', async () => {
    await deleteUser();

    // Holds bio, location and showcase. deleteMany, not delete: most accounts have no
    // row and `delete` throws on a miss.
    expect(dbMock.dbWrite.userProfile.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
  });

  it('deletes every UserLink row', async () => {
    await deleteUser();

    expect(dbMock.dbWrite.userLink.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
  });

  it('removes the profile and links INSIDE the transaction', async () => {
    await deleteUser();

    // Outside it they stop being atomic with the soft delete: a failure between the two
    // leaves an account that is deleted with its profile live, or intact with it gone.
    // Identity against the delegate's own return value — prisma builds every element of
    // the array eagerly, so what lands in it is that PROMISE, not its result.
    const [ops] = dbMock.dbWrite.$transaction.mock.calls[0] as [unknown[]];
    expect(ops).toContain(dbMock.dbWrite.userProfile.deleteMany.mock.results[0].value);
    expect(ops).toContain(dbMock.dbWrite.userLink.deleteMany.mock.results[0].value);
  });
});

describe('deleteUser — paddleCustomerId is purged AFTER the cancels, never before', () => {
  it('leaves both provider ids alone in the soft-delete update', async () => {
    await deleteUser();

    // `paddleCustomerId: null` used to sit here. `cancelSubscriptionPlan` falls back to
    // reading it when no CustomerSubscription row remains, so nulling it in the
    // transaction meant that fallback could never fire on a deletion.
    const data = softDeleteData();
    expect(data).not.toHaveProperty('customerId');
    expect(data).not.toHaveProperty('paddleCustomerId');
  });

  it('purges paddleCustomerId in a later update', async () => {
    await deleteUser();

    expect(paymentIdUpdate()).toBeGreaterThan(-1);
    const [arg] = user.update.mock.calls[paymentIdUpdate()] as [{ data: Record<string, unknown> }];
    expect(arg.data).toEqual({ paddleCustomerId: null });
  });

  it('does NOT purge the Stripe customerId — deleting it breaks our own webhook', async () => {
    await deleteUser();

    // Deliberate, and the reason is not local to this file, so read it before "fixing" it:
    // deleteUser's own cancelSubscription calls stripe.subscriptions.del, and the resulting
    // customer.subscription.deleted is resolved by findFirst({ where: { customerId } }) in
    // upsertSubscription (stripe.service.ts:601-616). That throws before reaching either
    // customerSubscription.delete below it, so nulling customerId here leaves the row `active`
    // forever while Stripe retries the webhook for days — manufacturing the exact
    // deleted-account-with-a-live-subscription defect this work exists to remove.
    //
    // The GDPR scrub purges it instead, and must scrub Stripe FIRST: once the id is gone the
    // customer record cannot be found again.
    // Every path in WRITE_PATHS, not just user.update: a raw-SQL or updateMany purge
    // reintroduces the identical webhook break, and reaching for raw SQL to null a column is
    // an ordinary thing to do. Each path has a CONTROL test below proving the scan can see it,
    // so this zero is a measured absence rather than a selector that matches nothing.
    expect(dbWriteCallsMentioning('customerId')).toEqual([]);
  });

  it('CONTROL: the scan sees a customerId write via user.update', () => {
    // An empty-array assertion is the shape that passes forever when the selector is broken,
    // so the zero above is only worth anything with these two beside it. Not hypothetical: the
    // first version of this scan walked Object.keys(dbMock.dbWrite), which enumerates nothing
    // on a proxy, and returned [] for every input.
    void dbMock.dbWrite.user.update({ where: { id: USER_ID }, data: { customerId: null } });

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.user.update']);
  });

  it('CONTROL: the scan sees a customerId write via raw SQL', () => {
    // The route someone would actually reach for to null a column, and the one a user.update
    // assertion cannot see.
    void dbMock.dbWrite.$executeRawUnsafe('UPDATE "User" SET "customerId" = NULL WHERE id = 1');

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.$executeRawUnsafe']);
  });

  it('CONTROL: the scan sees a customerId write via updateMany', () => {
    void dbMock.dbWrite.user.updateMany({ where: { id: USER_ID }, data: { customerId: null } });

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.user.updateMany']);
  });

  it('CONTROL: the scan sees a customerId write via $queryRawUnsafe', () => {
    void dbMock.dbWrite.$queryRawUnsafe('UPDATE "User" SET "customerId" = NULL RETURNING id');

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.$queryRawUnsafe']);
  });

  it('CONTROL: the scan sees a customerId write via tagged $queryRaw', () => {
    void dbMock.dbWrite.$queryRaw(['UPDATE "User" SET "customerId" = NULL RETURNING id'] as never);

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.$queryRaw']);
  });

  it('CONTROL: the scan sees a customerId write via upsert', () => {
    void dbMock.dbWrite.user.upsert({
      where: { id: USER_ID },
      create: { customerId: null },
      update: { customerId: null },
    } as never);

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.user.upsert']);
  });

  it('CONTROL: the scan sees a customerId write via tagged raw SQL', () => {
    // One control per path in WRITE_PATHS. A path named in that list but never demonstrated
    // observable is a claim of coverage the scan may not have — the same failure as the
    // Object.keys version, just narrower.
    void dbMock.dbWrite.$executeRaw(['UPDATE "User" SET "customerId" = NULL'] as never);

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.$executeRaw']);
  });

  it('purges them even when the steps in between blow up', async () => {
    // Moving the null out of the transaction gave up a free guarantee: in there it could
    // not be skipped. `bust`, `queueUpdate` and `deleteBasicDataForUser` are unwrapped,
    // so without the `finally` a Redis outage aborts deleteUser and leaves the Stripe
    // pointer live on an account that is already soft-deleted — no retry, no signal, and
    // the one link this PR exists to cut still standing.
    vi.spyOn(userFollowsCache, 'bust').mockRejectedValue(new Error('redis down'));

    await expect(deleteUser()).rejects.toThrow('redis down');

    // The PAYLOAD, not merely that some update ran: a finally that fires with the wrong
    // data would satisfy a bare "an update happened" assertion while purging nothing.
    expect(
      paymentIdUpdate(),
      'no update purged paddleCustomerId — the purge was skipped when an earlier await threw'
    ).toBeGreaterThan(-1);
    const [arg] = user.update.mock.calls[paymentIdUpdate()] as [{ data: Record<string, unknown> }];
    expect(arg.data).toEqual({ paddleCustomerId: null });
  });

  it('runs that purge AFTER the subscription cancels have read the ids', async () => {
    await deleteUser();

    // The ORDER is the guarantee, not the end state: an assertion that the id ends up
    // null passes just as well with the update back inside the transaction, which is
    // exactly the bug that shipped for paddle.
    //
    // Anchored on the read that actually needs the id — cancelSubscriptionPlan's fallback
    // `user.findUnique` — not on the first cancel to run. The Stripe cancel goes first, so
    // a purge moved BETWEEN the two cancels would still land after it and pass, while
    // nulling paddleCustomerId just before the one call that reads it.
    //
    // Existence first, order second: collapsed into one comparison, a purge that never ran
    // indexes invocationCallOrder at -1 and reads as a mis-ordered purge instead.
    const purgeIndex = paymentIdUpdate();
    expect(purgeIndex, 'no update purged paddleCustomerId at all').toBeGreaterThan(-1);

    const paddleFallbackRead = dbMock.dbWrite.user.findUnique.mock.invocationCallOrder.at(-1);
    expect(
      paddleFallbackRead,
      'the paddle fallback never read the user, so the order proves nothing'
    ).toBeDefined();

    expect(
      user.update.mock.invocationCallOrder[purgeIndex],
      'paddleCustomerId was purged BEFORE the paddle fallback read it'
    ).toBeGreaterThan(paddleFallbackRead as number);
  });
});
