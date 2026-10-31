import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionCoverVisibility from '~/server/services/collection-cover-visibility';
import type * as CollectionService from '~/server/services/collection.service';

/**
 * The collections feed shows a collection's own cover only when the viewer may see it; otherwise
 * the collection falls back to covers taken from its items.
 */

const {
  mockGetAllCollections,
  mockGetCollectionCoverImages,
  mockServableCovers,
  mockGetCollectionById,
  mockServableIds,
  mockPermissions,
} = vi.hoisted(() => ({
  mockServableIds: vi.fn(),
  mockPermissions: vi.fn(),
  mockGetAllCollections: vi.fn(),
  mockGetCollectionCoverImages: vi.fn(),
  mockServableCovers: vi.fn(),
  mockGetCollectionById: vi.fn(),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getAllCollections: mockGetAllCollections,
  getCollectionCoverImages: mockGetCollectionCoverImages,
  getCollectionItemCount: vi.fn().mockResolvedValue([]),
  getContributorCount: vi.fn().mockResolvedValue([]),
  getCollectionById: mockGetCollectionById,
  upsertCollection: vi.fn().mockResolvedValue({
    id: 1,
    name: 'c',
    userId: 1,
    image: { id: 500, url: 'stored-cover-url', ingestion: 'Scanned', type: 'image' },
  }),
  checkUserOwnsCollectionAndItem: vi.fn().mockResolvedValue(true),
  getUserCollectionPermissionsById: mockPermissions,
}));

vi.mock('~/server/services/collection-collaborator.service', () => ({
  getCollectionRoster: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/server/services/collection-cover-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionCoverVisibility>()),
  withServableCovers: mockServableCovers,
  getServableCoverCollectionIds: mockServableIds,
}));

import {
  getAllCollectionsInfiniteHandler,
  getCollectionByIdHandler,
  upsertCollectionHandler,
} from '../collection.controller';

const VIEWER = { id: 4, isModerator: false };
const row = (id: number) => ({
  id,
  userId: 1,
  name: `c${id}`,
  metadata: {},
  image: { id: 100 + id, url: `cover-${id}`, meta: null, tags: [] },
});

const servableOnly = (ids: number[]) => async (rows: ReturnType<typeof row>[]) =>
  rows.map((r) => (ids.includes(r.id) ? r : { ...r, image: null }));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllCollections.mockResolvedValue([row(1), row(2)]);
  mockGetCollectionCoverImages.mockResolvedValue([]);
});

const feed = () =>
  getAllCollectionsInfiniteHandler({
    input: { limit: 10 } as never,
    ctx: { user: VIEWER } as never,
  });

describe('getAllCollectionsInfiniteHandler covers', () => {
  it('keeps every cover the viewer may see (control)', async () => {
    mockServableCovers.mockImplementation(servableOnly([1, 2]));
    const { items } = await feed();
    expect(items.map((i) => i.image?.id ?? null)).toEqual([101, 102]);
    expect(mockGetCollectionCoverImages).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: [] })
    );
  });

  it('drops a cover the viewer may not see and falls back to item covers for it', async () => {
    mockServableCovers.mockImplementation(servableOnly([1]));
    const { items } = await feed();
    expect(items.map((i) => i.image?.id ?? null)).toEqual([101, null]);
    expect(mockServableCovers).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 })],
      VIEWER
    );
    expect(mockGetCollectionCoverImages).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: [2] })
    );
  });
});

describe('getCollectionByIdHandler', () => {
  const byId = async (manage: boolean) => {
    mockPermissions.mockResolvedValue({ read: true, manage });
    mockGetCollectionById.mockResolvedValue({ id: 1, image: null, coverHidden: true });
    return getCollectionByIdHandler({
      input: { id: 1 },
      ctx: { user: VIEWER, features: {}, req: { headers: {} } } as never,
    });
  };

  it("judges the cover for the signed-in viewer, so they keep their own image's cover", async () => {
    await byId(false);
    expect(mockGetCollectionById).toHaveBeenCalledWith({ input: { id: 1 }, viewer: VIEWER });
  });

  it('tells only an editor that a cover is hidden from them', async () => {
    expect((await byId(true)).collection?.coverHidden).toBe(true);
    expect((await byId(false)).collection?.coverHidden).toBe(false);
  });
});

describe('upsertCollectionHandler', () => {
  it('returns no cover when the stored cover is hidden from the editor', async () => {
    mockServableIds.mockResolvedValue(new Set());
    const result = await upsertCollectionHandler({
      input: { id: 1, name: 'c' } as never,
      ctx: { user: VIEWER } as never,
    });
    expect(result.image).toBeNull();
    expect(mockServableIds).toHaveBeenCalledTimes(1);
    expect(mockServableIds).toHaveBeenCalledWith(
      [{ collectionId: 1, collectionOwnerId: 1, imageId: 500 }],
      VIEWER
    );
  });

  it('returns the stored cover by id only, never its url', async () => {
    mockServableIds.mockResolvedValue(new Set([1]));
    const result = await upsertCollectionHandler({
      input: { id: 1, name: 'c' } as never,
      ctx: { user: VIEWER } as never,
    });
    expect(result.image).toEqual({ id: 500 });
    expect(JSON.stringify(result)).not.toContain('stored-cover-url');
  });
});
