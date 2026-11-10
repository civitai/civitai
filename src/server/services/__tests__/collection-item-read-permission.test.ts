import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * Collection item reads follow the collection's read permission (collection.getById's rule: read,
 * write or manage). A collection the viewer may not read answers exactly as a missing one:
 * - `collection.getAllCollectionItems` (requireRead) throws the same not-found error;
 * - `collection.getEntryCount` throws the same not-found error, unless the viewer may submit.
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

const route = (async (strings: TemplateStringsArray) => {
  const sql = strings.join('?');
  if (sql.includes('FROM "CollectionItem" ci'))
    return [
      { id: 1, imageId: 5, modelId: null, postId: null, articleId: null, status: 'ACCEPTED' },
    ];
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
    ? { id: COLLECTION_ID, type: 'Image', mode: null, userId: OWNER }
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
  mockGetAllImages.mockResolvedValue({ items: [{ id: 5 }] });
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

  it('lists Public and Unlisted collections to anyone (control)', async () => {
    for (const read of ['Public', 'Unlisted']) {
      collectionIs({ read });
      expect((await listItems(COLLECTION_ID, STRANGER)).items.length).toBeGreaterThan(0);
    }
  });
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
