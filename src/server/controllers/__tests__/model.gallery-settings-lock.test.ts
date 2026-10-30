import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { rowChangesBeforeLock } from '~/server/services/__tests__/model-row-lock.fake';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const { mockBustGallerySettings } = vi.hoisted(() => ({ mockBustGallerySettings: vi.fn() }));
vi.mock('~/server/services/creator-gallery-hidden-users.service', () => ({
  bustModelGallerySettings: mockBustGallerySettings,
  getCreatorGalleryHiddenUserIds: vi.fn(),
}));

const { updateGallerySettingsHandler } = await import('../model.controller');

/**
 * A minor or SFW-only flag holds the owner's gallery at SFW. A flag set, or the model moved to
 * another owner, after an earlier read of the model is in the row the save locks, and the save is
 * decided from that row.
 */

const MODEL = 1;
const OWNER = 5;
const MATURE_LEVEL = 31;
const row = { id: MODEL, userId: OWNER, minor: false, sfwOnly: false, meta: null };

let fake: ReturnType<typeof rowChangesBeforeLock>;
function rowChanges(locked: Partial<typeof row> | null) {
  fake = rowChangesBeforeLock(row, locked && { ...row, ...locked });
}

const save = (userId = OWNER, isModerator = false) =>
  updateGallerySettingsHandler({
    input: {
      id: MODEL,
      gallerySettings: {
        hiddenImages: [],
        hiddenUsers: [],
        hiddenTags: [],
        level: MATURE_LEVEL,
        pinnedPosts: {},
      },
    },
    ctx: { user: { id: userId, isModerator } } as never,
  } as never);

const writtenLevel = () => (fake.written().gallerySettings as { level: number }).level;

beforeEach(() => {
  vi.clearAllMocks();
  mockBustGallerySettings.mockResolvedValue(undefined);
  dbMock.dbWrite.model.update.mockImplementation((async ({ data }: { data: object }) => ({
    ...row,
    ...data,
  })) as never);
});

describe('updateGallerySettingsHandler — decides from the row it locks', () => {
  it.each([['minor', { minor: true }] as const, ['SFW-only', { sfwOnly: true }] as const])(
    "holds the owner's gallery at SFW when the model was flagged %s since an earlier read",
    async (_flag, flag) => {
      rowChanges(flag);
      await save();
      expect(writtenLevel()).toBe(sfwBrowsingLevelsFlag);
    }
  );

  it('refuses the save when the model moved to another owner since an earlier read', async () => {
    rowChanges({ userId: OWNER + 1 });
    await expect(save()).rejects.toThrow(/No model with id/);
    expect(fake.tx.model.update).not.toHaveBeenCalled();
  });

  it('refuses the save when the model was deleted since an earlier read', async () => {
    rowChanges(null);
    await expect(save()).rejects.toThrow(/No model with id/);
    expect(fake.tx.model.update).not.toHaveBeenCalled();
  });

  it("keeps the owner's level on an unflagged model", async () => {
    rowChanges({});
    await save();
    expect(writtenLevel()).toBe(MATURE_LEVEL);
  });

  it("keeps a moderator's level on a flagged model", async () => {
    rowChanges({ minor: true, sfwOnly: true });
    await save(OWNER + 1, true);
    expect(writtenLevel()).toBe(MATURE_LEVEL);
  });

  it('busts the gallery settings after the write commits', async () => {
    rowChanges({});
    let committed = false;
    const transaction = dbMock.dbWrite.$transaction.getMockImplementation()!;
    dbMock.dbWrite.$transaction.mockImplementation((async (callback: never) => {
      const result = await transaction(callback);
      committed = true;
      return result;
    }) as never);
    mockBustGallerySettings.mockImplementation(async () => expect(committed).toBe(true));

    await save();

    expect(mockBustGallerySettings).toHaveBeenCalledWith([MODEL]);
  });
});

describe('updateGallerySettingsHandler — clearing the gallery settings', () => {
  const clear = (userId = OWNER, isModerator = false) =>
    updateGallerySettingsHandler({
      input: { id: MODEL, gallerySettings: null },
      ctx: { user: { id: userId, isModerator } } as never,
    } as never);

  it.each([['minor', { minor: true }] as const, ['SFW-only', { sfwOnly: true }] as const])(
    "keeps the owner's gallery at SFW when clearing it on a %s model",
    async (_flag, flag) => {
      rowChanges(flag);
      await clear();
      expect(fake.written().gallerySettings).toEqual({ level: sfwBrowsingLevelsFlag });
    }
  );

  it('clears an unflagged model', async () => {
    rowChanges({});
    await clear();
    expect(fake.written().gallerySettings).toBe(Prisma.JsonNull);
  });

  it("clears a flagged model's gallery for a moderator", async () => {
    rowChanges({ minor: true });
    await clear(OWNER + 1, true);
    expect(fake.written().gallerySettings).toBe(Prisma.JsonNull);
  });
});
