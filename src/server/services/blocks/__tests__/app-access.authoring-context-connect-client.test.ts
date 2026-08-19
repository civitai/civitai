import { describe, expect, it, vi } from 'vitest';

/**
 * `getAppListingAuthoringContext` MUST CARRY `connectClientId` — the backend half of the
 * up-front ownership-transfer refusal.
 *
 * 🔴 THE READ IS THE SEAM THAT WAS MISSING, not the component. The Collaborators tab can
 * only refuse a transfer up front if it knows the listing is connect-linked, and this is
 * the only read the authoring page makes. Until this field was added the column existed,
 * the server gated on it, the component test asserted the refusal MESSAGE renders — and
 * the fact never crossed the wire, so the owner met the refusal only after picking a
 * recipient. A field is not a guard; this pins the field, and the browser suite
 * (`src/tests/pages/apps/listing-collaborators-transfer.browser.test.tsx`) pins the
 * branch that reads it.
 *
 * 🔴 THE FAKE HONOURS THE `select`. It returns ONLY the columns the query asked for, so
 * deleting `connectClientId: true` from the service's `select` makes this go red — which
 * a canned fixture, returning the whole row regardless, could never do. That is the exact
 * fixture-collapse the sibling suites' headers warn about.
 *
 * DB deps mocked per the sibling convention (a `vi.hoisted` fake handed to
 * `dbRead`/`dbWrite`); no real Prisma.
 */

const { mockDb, mockWriteDb, table } = vi.hoisted(() => {
  /** The one row every read below is answered from. Mutable per test. */
  const table = {
    id: 'apl_1',
    slug: 'my-app',
    name: 'My App',
    status: 'approved',
    kind: 'offsite' as string,
    appBlockId: null as string | null,
    connectClientId: null as string | null,
    revisionOfId: null as string | null,
    userId: 10,
  };

  /**
   * Project `row` through a Prisma-style `select`. Columns NOT selected are ABSENT, the
   * way Prisma returns them — this is what makes the service's `select` observable.
   */
  const project = (select: Record<string, unknown> | undefined) => {
    const row: Record<string, unknown> = { ...table, appBlock: null, revisionOf: null };
    if (!select) return row;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
    return out;
  };

  const make = () => ({
    appBlock: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    appListing: {
      findUnique: vi.fn(
        async (...a: unknown[]): Promise<unknown> =>
          project((a[0] as { select?: Record<string, unknown> }).select)
      ),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    appCollaborator: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
  });
  return { mockDb: make(), mockWriteDb: make(), table };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockWriteDb }));

const { getAppListingAuthoringContext } = await import(
  '~/server/services/blocks/app-access.service'
);

/**
 * 🔴 THE TRANSFER PREDICATE IS DELIBERATELY NOT IMPORTED HERE. This suite's whole claim is
 * "the FIELD crosses the wire", and running it against a base revision has to produce a
 * BEHAVIOURAL red (`undefined` where a client id belongs), not an unresolved-import red —
 * a suite that fails to collect reports "no tests", which is indistinguishable from a
 * pass. The predicate's agreement with this value is pinned where it is actually
 * exercised: `src/tests/pages/apps/listing-collaborators-transfer.browser.test.tsx` drives
 * the real View, which calls the real `refusesTransferForConnectClient` on the real
 * payload.
 */

const OWNER = 10;

describe('the fake honours its select (positive control)', () => {
  /**
   * 🔴 Before believing anything below: prove the fake can return BOTH shapes and that
   * an unselected column really is absent. Without this, "the field came back" and "the
   * fake always returns everything" are indistinguishable.
   */
  it('omits a column the select did not ask for, and returns one it did', async () => {
    table.connectClientId = 'oc_1';
    const withField = (await mockDb.appListing.findUnique({
      where: { id: 'apl_1' },
      select: { id: true, connectClientId: true },
    })) as Record<string, unknown>;
    expect(withField).toEqual({ id: 'apl_1', connectClientId: 'oc_1' });

    const without = (await mockDb.appListing.findUnique({
      where: { id: 'apl_1' },
      select: { id: true },
    })) as Record<string, unknown>;
    expect('connectClientId' in without).toBe(false);
  });
});

describe('getAppListingAuthoringContext carries connectClientId', () => {
  it('🔴 a connect-linked OFF-SITE listing returns its client id to the owner', async () => {
    table.kind = 'offsite';
    table.appBlockId = null;
    table.connectClientId = 'oc_linked';

    const ctx = await getAppListingAuthoringContext({ appListingId: 'apl_1', userId: OWNER });

    expect(ctx.role).toBe('owner');
    expect(ctx.kind).toBe('offsite');
    expect(ctx.connectClientId).toBe('oc_linked');
  });

  it('🔴 THE CONTROL — an off-site listing with NO client returns null, not a truthy stub', async () => {
    table.kind = 'offsite';
    table.appBlockId = null;
    table.connectClientId = null;

    const ctx = await getAppListingAuthoringContext({ appListingId: 'apl_1', userId: OWNER });

    expect(ctx.connectClientId).toBeNull();
  });

  it('an ON-SITE listing returns null and stays transferable', async () => {
    table.kind = 'onsite';
    table.appBlockId = 'ab_1';
    table.connectClientId = null;

    const ctx = await getAppListingAuthoringContext({ appListingId: 'apl_1', userId: OWNER });

    expect(ctx.kind).toBe('onsite');
    expect(ctx.connectClientId).toBeNull();
  });
});
