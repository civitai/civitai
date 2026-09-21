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
// NOT covered: pgDbWrite and kyselyWrite (which runs over it), and user.updateManyAndReturn.
// Writes inside an interactive $transaction ARE covered: the shared mock runs the callback
// against dbMock.dbWrite, so a `tx.user.update` lands on the paths above. Add a path above
// if one of the uncovered ones starts writing customerId.

/** Labels of the covered dbWrite calls whose arguments mention `needle`. */
const dbWriteCallsMentioning = (needle: string) => {
  const hits: string[] = [];
  for (const get of WRITE_PATHS) {
    const [label, fn] = get();
    const calls = (fn as unknown as { mock?: { calls?: unknown[][] } })?.mock?.calls ?? [];
    for (const call of calls) {
      // BigInt-safe, and no silent fallback: String(call) turns an object into
      // "[object Object]", which would drop the needle and report a false absence.
      const serialized = JSON.stringify(call, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v
      );
      if (serialized?.includes(needle)) hits.push(label);
    }
  }
  return hits;
};

/** Index of the soft-delete update (the one carrying deletedAt) in user.update.mock.calls. */
const softDeleteIndex = () =>
  user.update.mock.calls.findIndex(
    ([arg]) => (arg as { data?: Record<string, unknown> })?.data?.deletedAt !== undefined
  );

/** The data object of the soft-delete update. */
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

  it('soft-deletes and removes the profile and links INSIDE one transaction', async () => {
    await deleteUser();

    // Outside it they stop being atomic with the soft delete: a failure between the two
    // leaves an account that is deleted with its profile live, or intact with it gone.
    // Identity against the delegate's own return value — prisma builds every element of
    // the array eagerly, so what lands in it is that PROMISE, not its result.
    const [ops] = dbMock.dbWrite.$transaction.mock.calls[0] as [unknown[]];
    expect(ops).toContain(dbMock.dbWrite.userProfile.deleteMany.mock.results[0].value);
    expect(ops).toContain(dbMock.dbWrite.userLink.deleteMany.mock.results[0].value);
    // The soft delete itself too: without this, awaiting the user.update outside the array
    // passed every test here, including the ones that say "inside the transaction".
    expect(ops).toContain(user.update.mock.results[softDeleteIndex()].value);
  });
});

describe('deleteUser — payment-provider ids', () => {
  it('nulls paddleCustomerId inside the transaction, as part of the soft delete', async () => {
    await deleteUser();

    // Atomic with the soft delete, so no later failure can leave it behind. This does mean
    // cancelSubscriptionPlan's no-row fallback, which reads the id, cannot fire on a deletion;
    // moving the null after the cancels was tried and reverted, because with seven live Paddle
    // subscriptions it bought a live API call per deletion for almost nothing to cancel.
    expect(softDeleteData()).toHaveProperty('paddleCustomerId', null);
    const [ops] = dbMock.dbWrite.$transaction.mock.calls[0] as [unknown[]];
    expect(ops).toContain(user.update.mock.results[softDeleteIndex()].value);
  });

  it('nulls subscriptionId inside the transaction, via raw SQL', async () => {
    await deleteUser();

    // Prisma cannot reach this column — it is absent from the User model — so the scan over
    // WRITE_PATHS is what sees it at all. 3,339 already-deleted accounts still held one when
    // this shipped: a pointer to the subscription, hence the customer, hence charges carrying
    // receipt_email. Nulling paddleCustomerId above does not close it.
    expect(dbWriteCallsMentioning('subscriptionId')).toEqual(['dbWrite.$executeRaw']);

    const rawCall = dbMock.dbWrite.$executeRaw.mock.calls.findIndex((call) =>
      JSON.stringify(call)?.includes('subscriptionId')
    );
    expect(rawCall).toBeGreaterThan(-1);

    // What the statement DOES, not just that it mentions the column. Without this, a
    // statement reading `SET "image" = NULL WHERE id = ${user.id} AND "subscriptionId" IS
    // NOT NULL` satisfies every other assertion here and leaves the pointer on the row.
    // Anchored on the assignment rather than the bare column name, which an insertion
    // beside it would slip past.
    const [strings] = dbMock.dbWrite.$executeRaw.mock.calls[rawCall] as [string[]];
    expect(strings.join('?')).toContain('SET "subscriptionId" = NULL');

    // The bound id, not an interpolated one: `id = ${user.id}` in a tagged template is a
    // parameter, so it arrives as its own argument rather than inside the SQL string.
    expect(dbMock.dbWrite.$executeRaw.mock.calls[rawCall]).toContain(USER_ID);

    // Atomic with the soft delete. In the post-transaction tail it would be skippable, which
    // is the defect #4978 exists to fix.
    const [ops] = dbMock.dbWrite.$transaction.mock.calls[0] as [unknown[]];
    expect(ops).toContain(dbMock.dbWrite.$executeRaw.mock.results[rawCall].value);
  });

  it('CONTROL: the scan reports nothing for subscriptionId when the delete does not write it', () => {
    // A BLEED control, not a visibility one: it shows the ['dbWrite.$executeRaw'] above comes
    // from the call deleteUser makes rather than from mock state left by an earlier test.
    // That the scan can SEE a $executeRaw write at all is a different property, carried by
    // the tagged-raw-SQL control further down.
    expect(dbWriteCallsMentioning('subscriptionId')).toEqual([]);
  });

  it('does NOT purge the Stripe customerId — deleting it breaks our own webhook', async () => {
    await deleteUser();

    // Deliberate, and the reason is not local to this file, so read it before "fixing" it:
    // deleteUser's own cancelSubscription calls stripe.subscriptions.del, and the resulting
    // customer.subscription.deleted is resolved by findFirst({ where: { customerId } }) in
    // upsertSubscription, which throws before reaching either customerSubscription.delete
    // below it, so Stripe retries the webhook for days.
    //
    // The GDPR scrub purges it instead, and must scrub Stripe FIRST: once the id is gone the
    // customer record cannot be found again.
    //
    // Every path in WRITE_PATHS, not just user.update: a raw-SQL or updateMany purge
    // reintroduces the identical webhook break, and reaching for raw SQL to null a column is
    // an ordinary thing to do. Each path has a CONTROL test below proving the scan can see it,
    // so this zero is a measured absence rather than a selector that matches nothing.
    expect(dbWriteCallsMentioning('customerId')).toEqual([]);
  });

  it('CONTROL: the scan sees a customerId write via user.update', () => {
    // An empty-array assertion is the shape that passes forever when the selector is broken,
    // so the zero above is only worth anything with these beside it. Not hypothetical: the
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

  it('CONTROL: the scan still sees customerId when a BigInt is in the same call', () => {
    // JSON.stringify throws on a BigInt. The previous fallback, String(call), turned the whole
    // argument into "[object Object]" and dropped the needle — a false absence, not a failure.
    void dbMock.dbWrite.user.update({
      where: { id: 1n as never },
      data: { customerId: null },
    } as never);

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.user.update']);
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

  it('CONTROL: the scan sees a customerId write inside an interactive $transaction', async () => {
    // Only true because the shared mock runs the callback. A test-local override returning
    // its argument unrun used to hide exactly this route.
    await dbMock.dbWrite.$transaction(async (tx: typeof dbMock.dbWrite) =>
      tx.user.update({ where: { id: USER_ID }, data: { customerId: null } })
    );

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.user.update']);
  });

  it('CONTROL: the scan sees a customerId write via tagged raw SQL', () => {
    // One control per path in WRITE_PATHS. A path named in that list but never demonstrated
    // observable is a claim of coverage the scan may not have — the same failure as the
    // Object.keys version, just narrower.
    void dbMock.dbWrite.$executeRaw(['UPDATE "User" SET "customerId" = NULL'] as never);

    expect(dbWriteCallsMentioning('customerId')).toEqual(['dbWrite.$executeRaw']);
  });
});
