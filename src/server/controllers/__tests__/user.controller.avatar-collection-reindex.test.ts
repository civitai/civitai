import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';

/**
 * Changing an avatar must re-index the collections that user owns — see the route-7 note in
 * collection-media-index.ts for why the removal-side leg cannot cover a replacement.
 */

const { mockUpdateUserById, mockGetUserById, mockIngestImage, mockCollectionsQueueUpdate } =
  vi.hoisted(() => ({
    mockUpdateUserById: vi.fn(),
    mockGetUserById: vi.fn(),
    mockIngestImage: vi.fn(),
    mockCollectionsQueueUpdate: vi.fn(),
  }));

vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserById: mockGetUserById,
  updateUserById: mockUpdateUserById,
  updateLeaderboardRankForUsers: vi.fn(),
  equipCosmetic: vi.fn(),
  unequipCosmeticByType: vi.fn(),
  createUserReferral: vi.fn(),
  isUsernamePermitted: vi.fn(async () => true),
  queueModelMetricPrivacyReindex: vi.fn(),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ingestImage: mockIngestImage,
  deleteImageById: vi.fn(),
  deleteImages: vi.fn(),
  queueReplacedImageDeletion: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(() => ({ catch: vi.fn() })) }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { updateUserHandler } from '~/server/controllers/user.controller';

const USER_ID = 5;
const OLD_PICTURE_ID = 42;
const NEW_PICTURE_ID = 99;
const OWNED_COLLECTION_A = 8801;
const OWNED_COLLECTION_B = 9107;
const NEW_AVATAR = '5c4d0f2e-7a91-4b6d-8e33-2f1c9ab07d54';

const collectionLookup = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]: [TemplateStringsArray]) =>
    Array.from(strings).join('?').includes('"Collection"')
  ) as [TemplateStringsArray, ...unknown[]] | undefined;

const replacePicture = (pictureId = NEW_PICTURE_ID) =>
  updateUserHandler({
    ctx: { user: { id: USER_ID } },
    input: {
      id: USER_ID,
      profilePicture: { id: pictureId, url: NEW_AVATAR, type: 'image', width: 256, height: 256 },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserById.mockResolvedValue({ profilePictureId: OLD_PICTURE_ID });
  mockUpdateUserById.mockResolvedValue({ id: USER_ID, profilePictureId: NEW_PICTURE_ID });
  mockIngestImage.mockResolvedValue(undefined);
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    Array.from(strings).join('?').includes('"Collection"')
      ? [{ collectionId: OWNED_COLLECTION_A }, { collectionId: OWNED_COLLECTION_B }]
      : []
  );
});

describe('avatar replacement re-indexes the owner’s collections', () => {
  it('queues an Update for every collection the user owns', async () => {
    await replacePicture();

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith([
      { id: OWNED_COLLECTION_A, action: SearchIndexUpdateQueueAction.Update },
      { id: OWNED_COLLECTION_B, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('resolves by Collection.userId, not through CollectionItem', async () => {
    await replacePicture();

    const call = collectionLookup();
    expect(call).toBeDefined();
    expect(Array.from(call![0]).join('?')).toMatch(/c\."userId"\s*=\s*\?/);
    expect(call!.slice(1)).toContain(USER_ID);
  });

  it('queues nothing when the picture is unchanged', async () => {
    mockGetUserById.mockResolvedValue({ profilePictureId: NEW_PICTURE_ID });

    await replacePicture(NEW_PICTURE_ID);

    expect(collectionLookup()).toBeUndefined();
    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });

  // A first avatar is a change too: those documents carry `profilePicture: null` until
  // something rebuilds them, so the new picture is missing rather than stale.
  it('queues when the user is setting an avatar for the first time', async () => {
    mockGetUserById.mockResolvedValue({ profilePictureId: null });

    await replacePicture();

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith([
      { id: OWNED_COLLECTION_A, action: SearchIndexUpdateQueueAction.Update },
      { id: OWNED_COLLECTION_B, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('still saves the profile when the collection lookup fails', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));

    await expect(replacePicture()).resolves.toMatchObject({ id: USER_ID });
    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'collection-media-index-resolve-failed' })
    );
  });

  it('still saves the profile when the queue write fails', async () => {
    mockCollectionsQueueUpdate.mockRejectedValue(new Error('redis unavailable'));

    await expect(replacePicture()).resolves.toMatchObject({ id: USER_ID });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'collection-media-index-enqueue-failed' })
    );
  });
});
