import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  assertOwnedModelVersions,
  lookupVersionOwners,
  resolveJsonPointer,
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

describe('resolveJsonPointer', () => {
  const data = {
    workflow: { modelVersionId: 7 },
    'a/b': { 'c~d': 1 },
    picks: [{ id: 3 }, { id: 4 }],
    zero: 0,
    nul: null,
  };

  it.each([
    ['/workflow/modelVersionId', 7],
    ['/a~1b/c~0d', 1],
    ['/picks/1/id', 4],
    ['/zero', 0],
    ['/nul', null],
  ])('%s resolves to %j', (pointer, value) => {
    expect(resolveJsonPointer(data, pointer)).toEqual({ found: true, value });
  });

  it.each([
    '/missing',
    '/workflow/missing',
    '/zero/x', // a step into a number
    '/picks/2/id', // out of range
    '/picks/01/id', // non-canonical index
    '/picks/-/id',
    '/picks/length', // an array's own property is not an element
    '/workflow/constructor', // inherited, not own
    '/a/b/c~0d', // ~1 decodes to "/", so "/a/b" is not "a/b"
  ])('%s resolves to nothing', (pointer) => {
    expect(resolveJsonPointer(data, pointer)).toEqual({ found: false });
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

  it("accepts the author's own version", async () => {
    await expect(
      assertOwnedModelVersions(decl([POINTER]), owned, AUTHOR, table({ 101: AUTHOR }))
    ).resolves.toBeUndefined();
  });

  it('refuses a missing version, and every malformed value, exactly as it refuses a stranger', async () => {
    const stranger = await refusal(
      assertOwnedModelVersions(decl([POINTER]), owned, AUTHOR, table({ 101: OTHER }))
    );
    const lookup = table({ 101: AUTHOR });
    for (const value of [
      999,
      '101',
      101.5,
      0,
      -101,
      2_147_483_648,
      null,
      true,
      [101],
      { id: 101 },
    ]) {
      const data = { workflow: { modelVersionId: value } };
      expect(
        await refusal(assertOwnedModelVersions(decl([POINTER]), data, AUTHOR, lookup)),
        JSON.stringify(value)
      ).toEqual(stranger);
    }
    // Only the well-formed id reached the database; the malformed values were refused first.
    expect(lookup.mock.calls).toEqual([[[999]]]);
  });

  it('allows a declared field that is absent, without a database read', async () => {
    const lookup = table({});
    for (const data of [{}, { workflow: {} }, { workflow: 'not an object' }]) {
      await expect(
        assertOwnedModelVersions(decl([POINTER]), data, AUTHOR, lookup)
      ).resolves.toBeUndefined();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('an anonymous writer owns nothing: refused when a declared field is present', async () => {
    const lookup = table({ 101: AUTHOR });
    expect(
      (await refusal(assertOwnedModelVersions(decl([POINTER]), owned, null, lookup))).code
    ).toBe('resource_not_owned');
    await expect(
      assertOwnedModelVersions(decl([POINTER]), {}, null, lookup)
    ).resolves.toBeUndefined();
  });

  it('checks every declared pointer in one read: one stranger among owned versions is refused', async () => {
    const pointers = ['/a', '/b/0', '/c'];
    const lookup = table({ 1: AUTHOR, 2: AUTHOR, 3: OTHER });
    const data = { a: 1, b: [2], c: 3 };
    expect(
      (await refusal(assertOwnedModelVersions(decl(pointers), data, AUTHOR, lookup))).details
    ).toEqual({ pointer: '/c' });
    expect(lookup.mock.calls).toEqual([[[1, 2, 3]]]);
    await expect(
      assertOwnedModelVersions(decl(pointers), { a: 1, b: [2], c: 1 }, AUTHOR, lookup)
    ).resolves.toBeUndefined();
  });

  it('[invariant guard] a collection without the rule is never checked', async () => {
    const lookup = table({ 101: OTHER });
    await expect(assertOwnedModelVersions(decl(), owned, AUTHOR, lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
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
});
