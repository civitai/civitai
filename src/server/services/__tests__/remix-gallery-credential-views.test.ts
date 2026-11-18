import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The remix gallery hydrates its page through the image feed with the views the request's
 * credential allows, and with none when the caller names none.
 */

const { getAllImages } = vi.hoisted(() => ({
  getAllImages: vi.fn(async (_input: unknown) => ({ items: [], nextCursor: undefined })),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAllImages,
}));

const { getRemixGallery } = await import('~/server/services/remix-gallery.service');

const moderator = { id: 5, isModerator: true } as never;
type Views = { asModerator?: boolean; asOwner?: boolean };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([
    { placementId: 1, imageId: 101, placerId: 9, pinned: 0, position: 1, sortKey: 1 },
  ] as never);
});

describe('remix gallery hydration', () => {
  it.each<[string, Views]>([
    ['a scoped key', { asModerator: false, asOwner: false }],
    ['a session (control)', { asModerator: true, asOwner: true }],
    ['a caller naming no view (fail closed)', {}],
  ])("reads a moderator's page on %s", async (_, views) => {
    await getRemixGallery({ hostImageId: 1, browsingLevel: 1, user: moderator, ...views });
    expect(getAllImages).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: [101],
        asModerator: views.asModerator ?? false,
        asOwner: views.asOwner ?? false,
      })
    );
  });
});
