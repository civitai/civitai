import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

const lag = vi.hoisted(() => ({ recentlyWritten: new Set<number>() }));
// The real routing rule (any recently written id → the primary) is driven from a set here: the
// real tracker reads its window from env at module load, which a per-file override cannot reach.
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => {
  const real = await importOriginal<typeof LagHelpers>();
  const { dbMock: db } = await import('~/__tests__/mocks/db.mock');
  return {
    ...real,
    getDbWithoutLagBatch: vi.fn(async (_type: string, ids: (number | string)[]) =>
      ids.some((id) => lag.recentlyWritten.has(Number(id))) ? db.dbWrite : db.dbRead
    ),
  };
});

import { getDbWithoutLagBatch } from '~/server/db/db-lag-helpers';
import {
  assertOwnedModelVersions,
  lookupVersionOwners,
  resolveOwnedPointer,
  type VersionOwnerLookup,
} from '~/server/services/apps/doc-store-ownership';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { DeclaredStorageCollection } from '~/shared/constants/block-storage.constants';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const AUTHOR = 41_207;
const OTHER = 58_913;

const decl = (ownedModelVersions?: string[]): DeclaredStorageCollection => ({
  kind: 'docs',
  visibility: 'shared',
  write: 'own',
  counters: [],
  marks: [],
  indexes: new Map(),
  showAuthor: false,
  ...(ownedModelVersions ? { ownedModelVersions } : {}),
});

/** A lookup over a fixed id → owner table, recording what it was asked. */
function table(owners: Record<number, number>) {
  return vi.fn<VersionOwnerLookup>(
    async (ids) =>
      new Map(ids.filter((id) => id in owners).map((id) => [id, owners[id]] as [number, number]))
  );
}

async function refusal(p: Promise<void>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(DocStoreError);
  const { code, message, details } = err as DocStoreError;
  return { code, message, details };
}

describe('resolveOwnedPointer', () => {
  const data = {
    workflow: { modelVersionId: 7 },
    picks: [{ id: 3 }, { id: 4 }],
    zero: 0,
    nul: null,
  };

  it.each([
    ['/workflow/modelVersionId', 7],
    ['/zero', 0],
    ['/nul', null],
  ])('%s resolves to %j', (pointer, value) => {
    expect(resolveOwnedPointer(data, pointer)).toEqual({ found: true, value });
  });

  it.each([
    '/missing',
    '/workflow/missing',
    '/zero/x', // a step into a number
    '/nul/x', // a step into null
    '/picks/id', // a step into an array: never indexed, so nothing is found
    '/picks/length', // an array's own property is not a field
    '/workflow/constructor', // inherited, not own
  ])('%s resolves to nothing', (pointer) => {
    expect(resolveOwnedPointer(data, pointer)).toEqual({ found: false });
  });

  it('an array at the root resolves nothing', () => {
    expect(resolveOwnedPointer([{ id: 1 }], '/id')).toEqual({ found: false });
  });
});

describe('assertOwnedModelVersions', () => {
  const POINTER = '/workflow/modelVersionId';
  const owned = { workflow: { modelVersionId: 101 } };

  it("refuses another user's version with resource_not_owned, naming the field", async () => {
    const lookup = table({ 101: OTHER });
    expect(await refusal(assertOwnedModelVersions(decl([POINTER]), owned, AUTHOR, lookup))).toEqual(
      {
        code: 'resource_not_owned',
        message: 'the model version at this field is not one the author owns',
        details: { pointer: POINTER },
      }
    );
    expect(lookup).toHaveBeenCalledWith([101]);
  });

  it("accepts the author's own version, up to the largest integer id", async () => {
    await expect(
      assertOwnedModelVersions(decl([POINTER]), owned, AUTHOR, table({ 101: AUTHOR }))
    ).resolves.toBeUndefined();
    const max = { workflow: { modelVersionId: 2_147_483_647 } };
    await expect(
      assertOwnedModelVersions(decl([POINTER]), max, AUTHOR, table({ 2_147_483_647: AUTHOR }))
    ).resolves.toBeUndefined();
  });

  it('allows a declared field that is absent, without a database read', async () => {
    const lookup = table({});
    for (const data of [
      {},
      { workflow: {} },
      { workflow: 'not an object' },
      // An array on the way is not stepped into, whatever its elements hold.
      { workflow: [{ modelVersionId: 101 }] },
    ]) {
      await expect(
        assertOwnedModelVersions(decl([POINTER]), data, AUTHOR, lookup)
      ).resolves.toBeUndefined();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('checks every declared pointer in one read: one stranger among owned versions is refused', async () => {
    const pointers = ['/a', '/b/id', '/c'];
    const lookup = table({ 1: AUTHOR, 2: AUTHOR, 3: OTHER });
    const data = { a: 1, b: { id: 2 }, c: 3 };
    expect(
      (await refusal(assertOwnedModelVersions(decl(pointers), data, AUTHOR, lookup))).details
    ).toEqual({ pointer: '/c' });
    expect(lookup.mock.calls).toEqual([[[1, 2, 3]]]);
    await expect(
      assertOwnedModelVersions(decl(pointers), { a: 1, b: { id: 2 }, c: 1 }, AUTHOR, lookup)
    ).resolves.toBeUndefined();
  });

  it('a lookup that fails is a retryable 503, never an acceptance', async () => {
    const failing = vi.fn<VersionOwnerLookup>(async () => {
      throw new Error('replica unreachable');
    });
    expect(
      await refusal(assertOwnedModelVersions(decl([POINTER]), owned, AUTHOR, failing))
    ).toEqual({
      code: 'service_unavailable',
      message: 'storage is temporarily unavailable',
      details: { retryAfter: 1 },
    });
    // The client sees only the 503, so the cause must reach the log.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      {
        name: 'app-blocks-doc-store-dependency-fault',
        type: 'error',
        error: 'Error',
        message: 'replica unreachable',
      },
      'app-blocks'
    );
  });
});

describe('lookupVersionOwners', () => {
  const row = (
    id: number,
    userId: number,
    over: { status?: string; modelStatus?: string; deletedAt?: Date | null } = {}
  ) => ({
    id,
    status: over.status ?? ModelStatus.Published,
    model: {
      userId,
      status: over.modelStatus ?? ModelStatus.Published,
      deletedAt: over.deletedAt ?? null,
    },
  });

  it('maps each live version to its model owner and drops every deleted one', async () => {
    lag.recentlyWritten.clear();
    dbMock.dbRead.modelVersion.findMany.mockResolvedValueOnce([
      row(1, AUTHOR),
      row(2, OTHER, { status: ModelStatus.Draft }),
      row(3, AUTHOR, { status: ModelStatus.Deleted }),
      row(4, AUTHOR, { modelStatus: ModelStatus.Deleted }),
      row(5, AUTHOR, { deletedAt: new Date('2030-01-01T00:00:00Z') }),
    ]);
    const owners = await lookupVersionOwners([1, 2, 3, 4, 5, 6]);
    expect([...owners]).toEqual([
      [1, AUTHOR],
      [2, OTHER],
    ]);
    expect(dbMock.dbRead.modelVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 2, 3, 4, 5, 6] } } })
    );
  });

  it('a version written within the lag window is read from the primary, where the replica would miss it', async () => {
    const JUST_PUBLISHED = 77_001;
    // The replica has not caught up; the primary has the new version.
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([row(JUST_PUBLISHED, AUTHOR)]);

    // Control: not flagged, so the replica answers and the version looks missing.
    lag.recentlyWritten.clear();
    expect([...(await lookupVersionOwners([JUST_PUBLISHED]))]).toEqual([]);

    lag.recentlyWritten.add(JUST_PUBLISHED);
    expect([...(await lookupVersionOwners([JUST_PUBLISHED]))]).toEqual([[JUST_PUBLISHED, AUTHOR]]);
    expect(vi.mocked(getDbWithoutLagBatch)).toHaveBeenLastCalledWith('modelVersion', [
      JUST_PUBLISHED,
    ]);
    lag.recentlyWritten.clear();
  });
});
