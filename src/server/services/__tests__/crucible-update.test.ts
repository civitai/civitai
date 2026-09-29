import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as CoverImageService from '~/server/services/cover-image.service';

const throwOnBlockedUserContent = vi.fn();
const resolveCoverImageId = vi.fn();

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent,
}));

vi.mock('~/server/services/cover-image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverImageService>()),
  resolveCoverImageId,
}));

const { updateCrucible } = await import('~/server/services/crucible.service');

const OWNER = 4;
const findUnique = dbMock.dbRead.crucible.findUnique;
const update = dbMock.dbWrite.crucible.update;

const crucible = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  userId: OWNER,
  status: CrucibleStatus.Active,
  endAt: new Date(Date.now() + 60 * 60 * 1000),
  imageId: 50,
  nsfwLevel: 1,
  name: 'Old name',
  description: 'Old description',
  allowedResources: null,
  ...overrides,
});

const edit = (input: Record<string, unknown>, userId = OWNER, isModerator = false) =>
  updateCrucible({ id: 1, ...input, userId, isModerator } as Parameters<typeof updateCrucible>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(crucible());
  update.mockImplementation(async ({ data }: { data: object }) => ({ id: 1, ...data }));
  throwOnBlockedUserContent.mockResolvedValue(undefined);
  resolveCoverImageId.mockResolvedValue(77);
});

describe('updateCrucible — who may edit', () => {
  it('lets the owner rename a running crucible', async () => {
    await edit({ name: 'New name' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'New name' }) })
    );
  });

  it('refuses someone who neither owns nor moderates it', async () => {
    await expect(edit({ name: 'x' }, 99)).rejects.toThrow(/your own crucible/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses the owner once the end time has passed, even before finalization', async () => {
    findUnique.mockResolvedValue(crucible({ endAt: new Date(Date.now() - 1000) }));
    await expect(edit({ name: 'x' })).rejects.toThrow(/has ended/);
  });

  it('lets a moderator edit an ended crucible', async () => {
    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Completed }));
    await edit({ name: 'Cleaned up' }, 1, true);
    expect(update).toHaveBeenCalled();
  });
});

describe('updateCrucible — what may change', () => {
  it('only lets moderators change the content levels', async () => {
    await expect(edit({ nsfwLevel: 31 })).rejects.toThrow(/Only moderators/);
    await edit({ nsfwLevel: 3 }, 1, true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ nsfwLevel: 3 }) })
    );
  });

  it('refuses changing required resources once running', async () => {
    findUnique.mockResolvedValue(crucible({ allowedResources: [10] }));
    await expect(edit({ allowedResources: [11] })).rejects.toThrow(/before the crucible starts/);
  });

  it('lets the owner swap required resources before start, but not add a requirement', async () => {
    findUnique.mockResolvedValue(
      crucible({ status: CrucibleStatus.Pending, allowedResources: [10] })
    );
    await edit({ allowedResources: [11, 12] });
    expect(update).toHaveBeenCalled();

    findUnique.mockResolvedValue(crucible({ status: CrucibleStatus.Pending }));
    await expect(edit({ allowedResources: [11] })).rejects.toThrow(/not added or removed/);
  });

  it('runs the blocked-content guard on the text it will store', async () => {
    await edit({ description: 'Fresh description' });
    expect(throwOnBlockedUserContent).toHaveBeenCalledWith(
      ['Old name', 'Fresh description'],
      expect.objectContaining({ surface: 'crucible' })
    );
  });

  it('stores a new cover through the scanned cover path', async () => {
    await edit({
      coverImage: { url: '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900', width: 1, height: 1 },
    });
    expect(resolveCoverImageId).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, currentCoverId: 50 })
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ imageId: 77 }) })
    );
  });
});
