import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * Collection item reads follow the collection's read permission. Readers and managers see every
 * item; a viewer who may only submit sees their own; a collection the viewer may neither read nor
 * submit to answers exactly as a missing one:
 * - `collection.getAllCollectionItems` (requireRead) throws the same not-found error;
 * - `collection.getEntryCount` throws the same not-found error.
 * The permission rule runs for real over a mocked collection row.
 */
const { mockGetAllImages } = vi.hoisted(() => ({ mockGetAllImages: vi.fn() }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getAllImages: mockGetAllImages,
}));

import {
  getCollectionEntryCount,
  getCollectionItemsByCollectionId,
} from '~/server/services/collection.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const COLLECTION_ID = 7;
const OWNER = 9;
const STRANGER = { id: 77, isModerator: false };
const MOD = { id: 78, isModerator: true };

let collectionRow: Record<string, unknown> | null;

// One accepted item added by the stranger, one by someone else.
const OTHER_SUBMITTER = 500;
const ITEMS = [
  { id: 1, imageId: 5, addedById: OTHER_SUBMITTER },
  { id: 2, imageId: 6, addedById: 77 },
].map((item) => ({ ...item, modelId: null, postId: null, articleId: null, status: 'ACCEPTED' }));

/** The `ci."addedById" = $n` fragment's value, when the query restricts to one submitter. */
const addedByFilter = (values: unknown[]) => {
  for (const v of values) {
    const frag = v as { sql?: string; values?: unknown[] } | null;
    if (frag?.sql?.includes('"addedById"')) return { value: frag.values?.[0] };
  }
  return undefined;
};

const route = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?');
  if (sql.includes('FROM "CollectionItem" ci')) {
    const only = addedByFilter(values);
    return only ? ITEMS.filter((item) => item.addedById === only.value) : ITEMS;
  }
  if (sql.includes("c.metadata->'maxItemsPerUser'")) return collectionRow ? [{ total: 3 }] : [];
  if (sql.includes('FROM "CollectionItem"') && sql.includes('"addedById"'))
    return [{ status: 'ACCEPTED', count: 1 }];
  if (sql.includes('FROM "Collection" c')) return collectionRow ? [collectionRow] : [];
  return [];
}) as never;

const collectionIs = (over: Record<string, unknown> | null) => {
  collectionRow = over && {
    id: COLLECTION_ID,
    read: 'Public',
    write: 'Private',
    userId: OWNER,
    type: 'Image',
    mode: null,
    collaborationDisabledAt: null,
    contributorPermissions: null,
    hasAcceptedSeat: false,
    ...over,
  };
  const found = collectionRow
    ? { id: COLLECTION_ID, type: 'Image', mode: collectionRow.mode, userId: OWNER }
    : null;
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    vi.mocked(db.collection.findUniqueOrThrow).mockImplementation((async () => {
      if (!found) throw new Error('No Collection found');
      return found;
    }) as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(route);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(route);
  mockGetAllImages.mockImplementation(async ({ ids }: { ids: number[] }) => ({
    items: ids.map((id) => ({ id })),
  }));
  collectionIs({});
});

const listItems = (collectionId: number, user?: object) =>
  getCollectionItemsByCollectionId({
    input: { collectionId, limit: 10, browsingLevel: 3 } as never,
    user: user as never,
    requireRead: true,
  });
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
  );

describe('collection items of a collection the viewer may not read', () => {
  it('answers a Private collection exactly as a missing one, for a stranger and signed out', async () => {
    collectionIs(null);
    const missing = await errorOf(listItems(COLLECTION_ID, STRANGER));
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });

    for (const user of [STRANGER, undefined]) {
      collectionIs({ read: 'Private' });
      expect(await errorOf(listItems(COLLECTION_ID, user))).toEqual(missing);
    }
    expect(mockGetAllImages).not.toHaveBeenCalled();
  });

  it('lists a Private collection to its owner and a moderator (control)', async () => {
    for (const user of [{ id: OWNER }, MOD]) {
      collectionIs({ read: 'Private' });
      expect((await listItems(COLLECTION_ID, user)).items.length).toBeGreaterThan(0);
    }
  });

  it('lists Public and Unlisted collections to anyone, signed out too (control)', async () => {
    for (const read of ['Public', 'Unlisted'])
      for (const user of [STRANGER, undefined]) {
        collectionIs({ read });
        expect((await listItems(COLLECTION_ID, user)).items.length).toBeGreaterThan(0);
      }
  });

  const imageIdsOf = async (user?: object) =>
    (await listItems(COLLECTION_ID, user)).items.map(
      (item) => (item as unknown as { data: { id: number } }).data?.id
    );

  it.each([
    ['open for submissions', 'Public'],
    ['open for reviewed submissions', 'Review'],
  ])("lists only the viewer's own items in a Private collection %s", async (_, write) => {
    collectionIs({ read: 'Private', write });
    expect(await imageIdsOf(STRANGER)).toEqual([6]);
  });

  it("lists only the viewer's own items in a Private contest (random order)", async () => {
    collectionIs({ read: 'Private', write: 'Public', mode: 'Contest' });
    expect(await imageIdsOf(STRANGER)).toEqual([6]);
  });

  it('answers a Private collection open for submissions as missing when signed out', async () => {
    collectionIs({ read: 'Private', write: 'Public' });
    expect(await errorOf(listItems(COLLECTION_ID, undefined))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists every item to a reader (control)', async () => {
    collectionIs({ read: 'Public', write: 'Public' });
    expect((await imageIdsOf(STRANGER)).sort()).toEqual([5, 6]);
  });
});

describe('the page cursor', () => {
  it.each([
    ['newest first', {}, STRANGER, dbMock.dbRead],
    [
      'oldest first (review)',
      { forReview: true, reviewSort: 'Oldest' },
      { id: OWNER },
      dbMock.dbWrite,
    ],
  ])(
    "reads the cursor item's position only from the requested collection, %s",
    async (_, extra, user, db) => {
      await getCollectionItemsByCollectionId({
        input: {
          collectionId: COLLECTION_ID,
          limit: 10,
          browsingLevel: 3,
          cursor: '123',
          ...extra,
        } as never,
        user: user as never,
        requireRead: true,
      });
      const itemQuery = vi
        .mocked(db.$queryRaw)
        .mock.calls.find(([strings]) =>
          (strings as unknown as string[]).join('?').includes('FROM "CollectionItem" ci')
        )!;
      const cursor = itemQuery
        .slice(1)
        .map((v) => v as { sql?: string; values?: unknown[] } | null)
        .find((frag) => frag?.sql?.includes('SELECT "createdAt"'))!;
      const lookups = cursor.sql!.match(/SELECT "createdAt" FROM "CollectionItem" WHERE[^)]*/g)!;
      expect(lookups.length).toBeGreaterThan(0);
      for (const lookup of lookups) expect(lookup).toContain('"collectionId" = ');
      expect(cursor.values).toContain(COLLECTION_ID);
    }
  );
});

describe('entry count of a collection the viewer may not read', () => {
  const count = (user: { id: number; isModerator?: boolean }) =>
    getCollectionEntryCount({
      collectionId: COLLECTION_ID,
      userId: user.id,
      isModerator: user.isModerator,
    });

  it('answers a Private collection exactly as a missing one', async () => {
    collectionIs(null);
    const missing = await errorOf(count(STRANGER));
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });

    collectionIs({ read: 'Private' });
    expect(await errorOf(count(STRANGER))).toEqual(missing);
  });

  it('counts for a viewer who may submit to a Private collection, its owner and a moderator', async () => {
    for (const [over, user] of [
      [{ read: 'Private', write: 'Review' }, STRANGER],
      [{ read: 'Private', write: 'Public' }, STRANGER],
      [{ read: 'Private' }, { id: OWNER }],
      [{ read: 'Private' }, MOD],
    ] as const) {
      collectionIs(over);
      expect(await count(user)).toMatchObject({ max: 3, ACCEPTED: 1 });
    }
  });
});
