import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function rowChanges(locked: Partial<typeof row>) {
  rowChangesBeforeLock(row, { ...row, ...locked });
  // The read the handler took before its lock, as it was.
  for (const db of [dbMock.dbRead, dbMock.dbWrite]) db.model.findFirst.mockResolvedValue(row);
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

const writtenLevel = () =>
  (dbMock.dbWrite.model.update.mock.calls[0][0] as { data: { gallerySettings: { level: number } } })
    .data.gallerySettings.level;

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
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
