import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectedContext } from '~/server/createContext';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';

// The blocklist write comes after the steps that hide a removed image, so its failure cannot leave
// the image in search or in cached posts.

const svc = vi.hoisted(() => ({
  addBlockedImage: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
  bustCachesForPosts: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  addBlockedImage: svc.addBlockedImage,
  queueImageSearchIndexUpdate: svc.queueImageSearchIndexUpdate,
  writeModeratorBlock: vi.fn(async (ids: number[]) => ({
    held: new Set(),
    underReview: new Set(),
    removedForCsam: new Set(),
    pHashes: new Map(ids.map((id) => [id, BigInt(123)])),
  })),
  updateImageReportStatusByReason: vi.fn(async () => []),
  invalidateManyImageExistence: vi.fn(async () => undefined),
  getReportViolationDetailsForImages: vi.fn(async () => ({})),
  getTagNamesForImages: vi.fn(async () => ({})),
  getResourceIdsForImages: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/image-removal-hold.service', () => ({
  holdRemovals: vi.fn(),
  canConfirmReRemoval: vi.fn(async () => true),
  heldRemovalSummary: vi.fn(),
}));
vi.mock('~/server/services/image-appeal-flag', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearReviewFlagsOnBlock: vi.fn(async () => undefined),
  keepPendingAppealFlags: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshProfilePicturesForImages: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/account-deletion-image-markers', () => ({
  clearAccountDeletionImageMarkers: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeEntityFromAllCollections: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/nsfwLevels.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueComicsForPanelImage: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustCachesForPosts: svc.bustCachesForPosts,
}));

import { setTosViolationHandler } from '../image.controller';

const ctx = {
  user: { id: 2, isModerator: true, roles: ['moderator:mod'] },
  ip: '1.2.3.4',
  track: { images: vi.fn() },
} as unknown as ProtectedContext;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findFirst.mockResolvedValue({
    nsfwLevel: 4,
    userId: 9,
    postId: 3,
    pHash: BigInt(123),
    post: null,
  } as never);
});

const remove = () =>
  setTosViolationHandler({ input: { id: 50, violationType: 'other' } as never, ctx });

describe('setTosViolationHandler and the documents showing the image', () => {
  it('looks up every document showing the removed image, after the blocklist write', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);
    svc.addBlockedImage.mockResolvedValue(undefined);

    await remove();

    const lookups = dbMock.dbWrite.$queryRaw.mock.calls
      .map(([strings, ...values]) => ({ text: (strings as string[]).join('?'), values }))
      .filter((q) => /"Post"|"ImageConnection"|"Article"/.test(q.text));
    const kinds = new Set(
      lookups.map((q) => q.text.match(/"Post"|"ImageConnection"|"Article"/)?.[0])
    );
    expect(kinds).toEqual(new Set(['"Post"', '"ImageConnection"', '"Article"']));
    expect(lookups.every((q) => q.values.every((v) => JSON.stringify(v) === '[50]'))).toBe(true);
    const firstLookup =
      dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[
        dbMock.dbWrite.$queryRaw.mock.calls.findIndex(([s]) =>
          /"Post"|"ImageConnection"|"Article"/.test((s as string[]).join('?'))
        )
      ];
    expect(svc.addBlockedImage.mock.invocationCallOrder[0]).toBeLessThan(firstLookup);
  });
});

describe('setTosViolationHandler blocklist write', () => {
  it('writes the hash (control)', async () => {
    svc.addBlockedImage.mockResolvedValue(undefined);

    await remove();

    expect(svc.addBlockedImage).toHaveBeenCalledWith(
      expect.objectContaining({ hash: BigInt(123), reason: 'TOS' })
    );
  });

  it('has already hidden the image when the blocklist write throws', async () => {
    svc.addBlockedImage.mockRejectedValue(new Error('no ClickHouse client'));

    dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);

    await expect(remove()).rejects.toThrow();

    // The documents showing it are still looked up.
    const looked = dbMock.dbWrite.$queryRaw.mock.calls.some(([strings]) =>
      (strings as string[]).join('?').includes('"Post"')
    );
    expect(looked).toBe(true);
    expect(svc.queueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [50],
      action: expect.anything(),
    });
    expect(svc.bustCachesForPosts).toHaveBeenCalledWith(3);
  });
});
