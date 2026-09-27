import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';

/**
 * A profile picture update only ever acts on the caller's own images: a picture id the caller
 * does not currently use is never connected, the scan reads the new row, and the replaced
 * picture is queued for deletion only when the caller owns it.
 *
 * To whoever is simplifying `updateUserHandler` back to a `connectOrCreate` on the input id:
 * that id is caller-supplied and may name any image.
 */

const { mockUpdateUserById, mockGetUserById, mockIngestImage, mockIngestImageById } = vi.hoisted(
  () => ({
    mockUpdateUserById: vi.fn(),
    mockGetUserById: vi.fn(),
    mockIngestImage: vi.fn(),
    mockIngestImageById: vi.fn(),
  })
);

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
  ingestImageById: mockIngestImageById,
  deleteImageById: vi.fn(),
  deleteImages: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ usersSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(() => ({ catch: vi.fn() })) }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { updateUserHandler } from '~/server/controllers/user.controller';

const CALLER_ID = 5;
const OTHER_USER_ID = 6;
const CURRENT_PICTURE_ID = 42;
const OTHER_USERS_IMAGE_ID = 7777;
const CREATED_PICTURE_ID = 99;
const AVATAR_KEY = '5c4d0f2e-7a91-4b6d-8e33-2f1c9ab07d54';

function queuedImageIds() {
  return dbMock.dbWrite.$executeRaw.mock.calls
    .filter((call: unknown[]) =>
      (call[0] as TemplateStringsArray).join('?').includes('INSERT INTO "JobQueue"')
    )
    .flatMap((call: unknown[]) =>
      call
        .slice(1)
        .flatMap((v) =>
          Array.isArray((v as { values?: unknown[] })?.values)
            ? (v as { values: unknown[] }).values
            : [v]
        )
    )
    .filter((v) => typeof v === 'number');
}

const saveProfilePicture = (pictureId?: number) =>
  updateUserHandler({
    ctx: { user: { id: CALLER_ID } },
    input: {
      id: CALLER_ID,
      profilePicture: { id: pictureId, url: AVATAR_KEY, type: 'image', width: 256, height: 256 },
    },
  } as never);

const currentPictureOwnedBy = (userId: number | null) =>
  mockGetUserById.mockResolvedValue({
    profilePictureId: userId === null ? null : CURRENT_PICTURE_ID,
    profilePicture: userId === null ? null : { userId },
  });

beforeEach(() => {
  vi.clearAllMocks();
  currentPictureOwnedBy(CALLER_ID);
  mockUpdateUserById.mockResolvedValue({ id: CALLER_ID, profilePictureId: CREATED_PICTURE_ID });
  mockIngestImage.mockResolvedValue(true);
  mockIngestImageById.mockResolvedValue(true);
});

describe('profile picture updates are scoped to the caller', () => {
  it('never connects an image id the caller supplied', async () => {
    await saveProfilePicture(OTHER_USERS_IMAGE_ID);

    const relation = mockUpdateUserById.mock.calls[0][0].data.profilePicture;
    expect(Object.keys(relation)).toEqual(['create']);
    expect(relation.create.id).toBeUndefined();
    expect(relation.create).toMatchObject({ url: AVATAR_KEY, userId: CALLER_ID });
  });

  it('scans the row it created, by id, not a url from the request', async () => {
    await saveProfilePicture(OTHER_USERS_IMAGE_ID);

    expect(mockIngestImageById).toHaveBeenCalledTimes(1);
    expect(mockIngestImageById).toHaveBeenCalledWith({ id: CREATED_PICTURE_ID });
    expect(mockIngestImage).not.toHaveBeenCalled();
  });

  it("does not queue the current picture for deletion when it is another user's image", async () => {
    currentPictureOwnedBy(OTHER_USER_ID);

    await saveProfilePicture();

    expect(queuedImageIds()).toEqual([]);
  });

  it("queues the caller's own replaced picture", async () => {
    await saveProfilePicture();

    expect(queuedImageIds()).toEqual([CURRENT_PICTURE_ID]);
  });

  it('changes nothing when the current picture is re-saved', async () => {
    await saveProfilePicture(CURRENT_PICTURE_ID);

    expect(mockUpdateUserById.mock.calls[0][0].data.profilePicture).toBeUndefined();
    expect(mockIngestImageById).not.toHaveBeenCalled();
    expect(queuedImageIds()).toEqual([]);
  });
});
