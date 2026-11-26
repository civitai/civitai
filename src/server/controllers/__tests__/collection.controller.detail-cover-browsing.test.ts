import { beforeEach, describe, expect, it, vi } from 'vitest';
import { childBrowsingTagIds } from '@civitai/shared';
import type * as CollectionService from '~/server/services/collection.service';
import type { Context } from '~/server/createContext';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const { mockGetPermissions, mockGetCollectionById } = vi.hoisted(() => ({
  mockGetPermissions: vi.fn(),
  mockGetCollectionById: vi.fn(),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockGetPermissions,
  getCollectionById: mockGetCollectionById,
}));

vi.mock('~/server/services/system-cache', async (importOriginal) => {
  const { DEFAULT_BROWSING_SETTINGS_ADDONS } = await import(
    '~/shared/constants/browsing-settings-addons'
  );
  return {
    ...(await importOriginal<object>()),
    getBlockedBrowsingTags: vi.fn(async () => []),
    getBrowsingSettingAddons: vi.fn(async () => DEFAULT_BROWSING_SETTINGS_ADDONS),
  };
});

const { getCollectionByIdHandler } = await import('~/server/controllers/collection.controller');

const CHILD_TAG = childBrowsingTagIds[0];
const OTHER_TAG = 999001;
const VIEWER_ID = 4242;
const IMAGE_OWNER = 5;

const mature = {
  id: VIEWER_ID,
  isModerator: false,
  showNsfw: true,
  browsingLevel: allBrowsingLevelsFlag,
};

function arrange({
  tagId = OTHER_TAG,
  flags = { poi: false, minor: false },
  manage = false,
}: { tagId?: number; flags?: { poi: boolean; minor: boolean }; manage?: boolean } = {}) {
  mockGetCollectionById.mockResolvedValue({
    id: 10,
    userId: 999,
    mode: 'Contest',
    read: 'Public',
    write: 'Public',
    coverHidden: false,
    image: { id: 100, userId: IMAGE_OWNER, nsfwLevel: 4, tags: [{ tag: { id: tagId } }] },
  });
  dbMock.dbRead.image.findUnique.mockResolvedValue(flags);
  mockGetPermissions.mockResolvedValue({
    collectionId: 10,
    isOwner: false,
    manage,
    read: true,
    write: false,
    collaborationDisabled: false,
    collectionMode: null,
  });
}

async function cover(user: object) {
  const ctx = { user, features: { canViewNsfw: true }, req: { headers: {} } } as unknown as Context;
  const { collection } = await getCollectionByIdHandler({ ctx, input: { id: 10 } });
  return { image: collection?.image?.id ?? null, coverHidden: collection?.coverHidden };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ pending: 0 }]);
});

describe('collection.getById cover and browsing-settings rules', () => {
  it('hides a child-tagged cover from a mature non-moderator and keeps a plain one', async () => {
    arrange({ tagId: CHILD_TAG });
    expect((await cover(mature)).image).toBeNull();
    arrange();
    expect((await cover(mature)).image).toBe(100);
  });

  it('hides a POI or minor-flagged cover from a mature non-moderator', async () => {
    arrange({ flags: { poi: true, minor: false } });
    expect((await cover(mature)).image).toBeNull();
    arrange({ flags: { poi: false, minor: true } });
    expect((await cover(mature)).image).toBeNull();
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledWith({
      where: { id: 100 },
      select: { poi: true, minor: true },
    });
  });

  it('hides a cover whose poi and minor flags could not be read', async () => {
    arrange();
    dbMock.dbRead.image.findUnique.mockResolvedValue(null);
    expect((await cover(mature)).image).toBeNull();
  });

  it('serves a moderator every cover', async () => {
    const mod = { ...mature, isModerator: true };
    arrange({ tagId: CHILD_TAG });
    expect((await cover(mod)).image).toBe(100);
    arrange({ flags: { poi: true, minor: true } });
    expect((await cover(mod)).image).toBe(100);
  });

  it("serves the cover's own uploader their image", async () => {
    arrange({ tagId: CHILD_TAG });
    expect((await cover({ ...mature, id: IMAGE_OWNER })).image).toBe(100);
  });

  it('tells a manager a hidden cover is stored, and no one else', async () => {
    arrange({ tagId: CHILD_TAG, manage: true });
    expect(await cover(mature)).toEqual({ image: null, coverHidden: true });
    arrange({ tagId: CHILD_TAG });
    expect(await cover(mature)).toEqual({ image: null, coverHidden: false });
  });
});
