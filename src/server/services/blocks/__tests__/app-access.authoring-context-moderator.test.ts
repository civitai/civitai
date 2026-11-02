import { describe, expect, it, vi } from 'vitest';

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
    // 🔴 `getAppListingAuthoringContext` NOW READS THE VISIBILITY LEVEL THROUGH RAW SQL, so a
    // file-local db mock has to carry `$queryRaw` or every case in this file dies with
    // `db.$queryRaw is not a function` — a collection-shaped failure that says nothing about
    // the behaviour under test. The column is `// @no-type` and absent from the generated
    // client, so it CANNOT be a Prisma `select`; raw is the only read there is.
    //
    // An empty result is the "no level expressed" answer (`available: true, visibility: null`),
    // which is the pre-feature behaviour and keeps each case below about what it was about.
    // The canonical shared mock already provides this; these files predate it.
    $queryRaw: vi.fn(async (): Promise<unknown[]> => []),
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

const OWNER = 10;
const MOD = 7;
const STRANGER = 99;

describe('getAppListingAuthoringContext admits a moderator who holds no seat', () => {
  it('a moderator opens the editor of a listing they do not own, as role moderator', async () => {
    const ctx = await getAppListingAuthoringContext({
      appListingId: 'apl_1',
      userId: MOD,
      isModerator: true,
    });
    expect(ctx.role).toBe('moderator');
  });

  it('a stranger who is not a moderator is refused', async () => {
    await expect(
      getAppListingAuthoringContext({ appListingId: 'apl_1', userId: STRANGER, isModerator: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a moderator who owns the listing is still the owner', async () => {
    const ctx = await getAppListingAuthoringContext({
      appListingId: 'apl_1',
      userId: OWNER,
      isModerator: true,
    });
    expect(ctx.role).toBe('owner');
  });
});
