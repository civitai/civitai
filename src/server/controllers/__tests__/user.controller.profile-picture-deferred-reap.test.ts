import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';

/**
 * #4272 — replacing a profile picture must not DESTROY the previous one.
 *
 * The old behaviour hard-deleted the previous `Image` row and its stored object inline, the
 * moment the new picture saved. The write is instant; the references are not — the image CDN
 * caches its redirect for 24h, the account-switcher roster in localStorage is durable by
 * design, and other surfaces hold rendered avatar urls. None of those are bugs on their own:
 * they only became user-visible breakage because the target was *gone* rather than merely
 * *stale*. A stale-but-present avatar is invisible; a deleted one is a broken image.
 *
 * These tests pin the BEHAVIOUR on the writer side of the seam — nothing about the
 * replacement destroys the old image, and the id is handed to the deferred reaper with the
 * key that reaper reads. The reader side (the window actually closing, and a re-adopted
 * image surviving it) is `src/server/jobs/__tests__/remove-replaced-images.test.ts`; both
 * files address the queue through the same `EntityType`/`JobQueueType` constants, so a
 * drift between writer and reader fails one of them rather than shipping.
 *
 * `queueReplacedImageDeletion` is deliberately NOT mocked: this file loads the real
 * `image.service` (`importOriginal`) so the assertion is about the statement that reaches
 * the database, not about a spy having been called.
 */

const {
  mockUpdateUserById,
  mockGetUserById,
  mockIngestImage,
  mockDeleteImageById,
  mockDeleteImages,
} = vi.hoisted(() => ({
  mockUpdateUserById: vi.fn(),
  mockGetUserById: vi.fn(),
  mockIngestImage: vi.fn(),
  mockDeleteImageById: vi.fn(),
  mockDeleteImages: vi.fn(),
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
// Only the two destroyers and the scanner hop are stubbed. `queueReplacedImageDeletion` is
// the real implementation, running against the canonical db mock.
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ingestImage: mockIngestImage,
  deleteImageById: mockDeleteImageById,
  deleteImages: mockDeleteImages,
}));
vi.mock('~/server/search-index', () => ({ usersSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(() => ({ catch: vi.fn() })) }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { updateUserHandler } from '~/server/controllers/user.controller';
import { EntityType, JobQueueType } from '~/shared/utils/prisma/enums';

const USER_ID = 5;
const OLD_PICTURE_ID = 42;
const NEW_PICTURE_ID = 99;
// A real profile picture url is a CF Images UUID — `verifyAvatar` drops anything else, and a
// dropped url takes the whole replacement branch with it, so a plausible-looking https fixture
// would make every assertion below pass vacuously.
const NEW_AVATAR = '5c4d0f2e-7a91-4b6d-8e33-2f1c9ab07d54';

/** Every `$executeRaw` the handler issued, as `{ sql, values }`. */
function writes() {
  return dbMock.dbWrite.$executeRaw.mock.calls.map((call: unknown[]) => ({
    sql: (call[0] as TemplateStringsArray).join('?'),
    values: call.slice(1),
  }));
}

function queueInsert() {
  return writes().find((w) => w.sql.includes('INSERT INTO "JobQueue"'));
}

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
});

describe('profile picture replacement (#4272)', () => {
  it('does not destroy the previous image — no row delete, no object delete', async () => {
    await replacePicture();

    // The two paths that would take the old picture off the internet. Either one firing here
    // reinstates the 404: the CDN keeps serving its cached redirect to a url that is gone.
    expect(mockDeleteImageById).not.toHaveBeenCalled();
    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.delete).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.deleteMany).not.toHaveBeenCalled();
  });

  it('queues the previous image for a deferred reap, addressed the way the reaper reads it', async () => {
    await replacePicture();

    const insert = queueInsert();
    expect(insert).toBeDefined();
    // The id, and the exact (entityType, type) pair `remove-replaced-images` selects on. A
    // queue row written under any other key is invisible to the reaper, which would leak the
    // image forever rather than reap it late.
    const bound = insert!.values.flatMap((v) =>
      // Prisma.sql fragments arrive as one value carrying its own `values`.
      Array.isArray((v as { values?: unknown[] })?.values)
        ? (v as { values: unknown[] }).values
        : [v]
    );
    expect(bound).toContain(OLD_PICTURE_ID);
    expect(bound).toContain(EntityType.Image);
    expect(bound).toContain(JobQueueType.ReplacedImageDelete);
  });

  it('restarts the retention window when an image is queued a second time', async () => {
    await replacePicture();

    // A user can re-select a picture they previously replaced away from, so the same id can
    // reach the queue twice. `ON CONFLICT DO NOTHING` would leave the FIRST replacement's
    // clock in place, and the second replacement would then get no retention at all — the
    // bug this whole change exists to remove, re-created on a slower path.
    expect(queueInsert()!.sql).toMatch(/ON CONFLICT[\s\S]*DO UPDATE SET "createdAt" = NOW\(\)/);
  });

  it('still applies the new picture immediately', async () => {
    await replacePicture();

    // Deferral must not be visible on the happy path: the user's new avatar takes effect on
    // save, exactly as before.
    const data = mockUpdateUserById.mock.calls[0][0].data;
    expect(data.profilePicture.connectOrCreate.where).toEqual({ id: NEW_PICTURE_ID });
    expect(mockIngestImage).toHaveBeenCalled();
  });

  it('queues nothing when the picture is unchanged', async () => {
    // Re-saving the same picture is not a replacement. Queuing here would schedule the
    // CURRENT avatar for deletion.
    mockGetUserById.mockResolvedValue({ profilePictureId: NEW_PICTURE_ID });

    await replacePicture(NEW_PICTURE_ID);

    expect(queueInsert()).toBeUndefined();
    expect(mockDeleteImageById).not.toHaveBeenCalled();
  });

  it('queues nothing when the user had no previous picture', async () => {
    mockGetUserById.mockResolvedValue({ profilePictureId: null });

    await replacePicture();

    expect(queueInsert()).toBeUndefined();
  });

  it('still saves the profile when the enqueue itself fails', async () => {
    // The enqueue runs inside the `Promise.all` that decides whether the save reports
    // success, and the save has already COMMITTED by then. A rejecting enqueue would
    // therefore turn a successful save into "error updating your profile" — which is also
    // exactly what a deploy that lands before the enum migration would do on every avatar
    // change. Failing to queue is a leaked object, not a user-visible failure.
    dbMock.dbWrite.$executeRaw.mockRejectedValueOnce(
      new Error('invalid input value for enum "JobQueueType"')
    );

    await expect(replacePicture()).resolves.toMatchObject({ id: USER_ID });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'queue-replaced-image-deletion-failed' })
    );
  });
});
