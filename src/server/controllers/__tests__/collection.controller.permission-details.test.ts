import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';

/**
 * `collection.getPermissionDetails` is a `protectedProcedure` taking arbitrary ids, so the
 * handler's own filtering is the only read gate on the name/metadata/mode/tags it returns.
 */

const { mockCollectionFindMany } = vi.hoisted(() => ({
  mockCollectionFindMany: vi.fn(),
}));

const { mockGetUserCollectionPermissionsById } = vi.hoisted(() => ({
  mockGetUserCollectionPermissionsById: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { collection: { findMany: mockCollectionFindMany } },
  dbWrite: {},
}));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockGetUserCollectionPermissionsById,
}));

import { getPermissionDetailsHandler } from '../collection.controller';

function collectionRow(id: number, name: string) {
  return { id, name, metadata: null, mode: null, tags: [] };
}

function permissions(collectionId: number, read: boolean) {
  return {
    collectionId,
    read,
    write: false,
    writeReview: false,
    manage: false,
    follow: false,
    isContributor: false,
    isOwner: false,
    publicCollection: read,
    followPermissions: [],
    collectionType: null,
    collectionMode: null,
  };
}

const ctx = { user: { id: 1, isModerator: false } } as never;

describe('getPermissionDetailsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits collections the user cannot read', async () => {
    mockCollectionFindMany.mockResolvedValue([
      collectionRow(10, 'public one'),
      collectionRow(11, "someone else's private one"),
    ]);
    mockGetUserCollectionPermissionsById.mockImplementation(async ({ id }: { id: number }) =>
      permissions(id, id === 10)
    );

    const result = await getPermissionDetailsHandler({ input: { ids: [10, 11] }, ctx });

    expect(result.map((c) => c.id)).toEqual([10]);
    expect(JSON.stringify(result)).not.toContain("someone else's private one");
  });

  it('returns the readable collection with its permissions attached', async () => {
    mockCollectionFindMany.mockResolvedValue([collectionRow(10, 'public one')]);
    mockGetUserCollectionPermissionsById.mockResolvedValue(permissions(10, true));

    const result = await getPermissionDetailsHandler({ input: { ids: [10] }, ctx });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('public one');
    expect(result[0].permissions.read).toBe(true);
  });

  it('short-circuits an empty id list without touching the db', async () => {
    const result = await getPermissionDetailsHandler({ input: { ids: [] }, ctx });

    expect(result).toEqual([]);
    expect(mockCollectionFindMany).not.toHaveBeenCalled();
  });
});
