import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { dbMock, loggingMock } from '~/__tests__/mocks';
import {
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
} from '~/shared/constants/crucible.constants';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CoverImageService from '~/server/services/cover-image.service';
import type * as TextModerationService from '~/server/services/text-moderation.service';

const throwOnBlockedUserContent = vi.fn();
const resolveCoverImageId = vi.fn();
const getUserBuzzAccount = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const submitTextModeration = vi.fn();

vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration,
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent,
}));

vi.mock('~/server/services/cover-image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverImageService>()),
  resolveCoverImageId,
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  getUserBuzzAccount,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
}));

const { updateCrucible } = await import('~/server/services/crucible.service');

const OWNER = 4;
const HOUR = 60 * 60 * 1000;
const findUnique = dbMock.dbRead.crucible.findUnique;
const update = dbMock.dbWrite.crucible.update;
const modelVersionCount = dbMock.dbRead.modelVersion.count;
const modelVersionFindMany = dbMock.dbRead.modelVersion.findMany;

/** Every id the service asks about counts as a published, public model version. */
const allPublished = async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.length;

const crucible = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  userId: OWNER,
  status: CrucibleStatus.Active,
  startAt: new Date(Date.now() - HOUR),
  endAt: new Date(Date.now() + HOUR),
  imageId: 50,
  heroImageId: null,
  buzzType: 'yellow',
  nsfwLevel: 1,
  name: 'Old name',
  description: 'Old description',
  contentType: MediaType.image,
  entryFee: 100,
  entryLimit: 1,
  freeEntriesPerUser: 0,
  maxTotalEntries: null,
  minViewSeconds: null,
  maxClipSeconds: null,
  prizePositions: { '1': 50, '2': 30, '3': 20 },
  allowedResources: null,
  duration: 24 * 60,
  seededPrizePool: 0,
  buzzTransactionId: null,
  seedTransactionId: null,
  ...overrides,
});
const upcoming = (overrides: Record<string, unknown> = {}) =>
  crucible({
    status: CrucibleStatus.Pending,
    startAt: new Date(Date.now() + 24 * HOUR),
    endAt: new Date(Date.now() + 48 * HOUR),
    ...overrides,
  });

const edit = (input: Record<string, unknown>, userId = OWNER, isModerator = false) =>
  updateCrucible({ id: 1, ...input, userId, isModerator } as Parameters<typeof updateCrucible>[0]);
const written = () => update.mock.calls[0][0].data as Record<string, unknown>;
const charged = () => createMultiAccountBuzzTransaction.mock.calls.map(([c]) => c.amount);
const refunded = () =>
  refundMultiAccountTransaction.mock.calls.map(([c]) => c.externalTransactionIdPrefix);

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(crucible());
  update.mockImplementation(async ({ data }: { data: object }) => ({ id: 1, ...data }));
  throwOnBlockedUserContent.mockResolvedValue(undefined);
  resolveCoverImageId.mockResolvedValue(77);
  getUserBuzzAccount.mockResolvedValue([{ balance: 1_000_000, type: 'yellow' }]);
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactions: [] });
  refundMultiAccountTransaction.mockResolvedValue(undefined);
  modelVersionCount.mockImplementation(allPublished);
  modelVersionFindMany.mockResolvedValue([]);
});

describe('updateCrucible — text scan', () => {
  it('puts it back under review and rescans the new text, read from the primary', async () => {
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue({ name: 'New name', description: null });

    await edit({ name: 'New name' });

    expect(written()).toMatchObject({ ingestion: 'Pending', scannedAt: null });
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Crucible', entityId: 1, content: 'New name' })
    );
  });

  it('leaves the verdict alone when the text is unchanged', async () => {
    await edit({ name: 'Old name', description: 'Old description', coverImage: { url: 'x' } });

    expect(written()).not.toHaveProperty('ingestion');
    expect(submitTextModeration).not.toHaveBeenCalled();
  });
});

describe('updateCrucible — who may edit', () => {
  it('lets the owner rename a running crucible', async () => {
    await edit({ name: 'New name' });
    expect(written()).toMatchObject({ name: 'New name' });
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

describe('updateCrucible — once running', () => {
  it('refuses anything but the presentation from the owner, naming what is locked', async () => {
    await expect(edit({ entryFee: 200, nsfwLevel: 3 })).rejects.toThrow(/entryFee, nsfwLevel/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses content-level changes from a moderator too', async () => {
    await expect(edit({ nsfwLevel: 3 }, 1, true)).rejects.toThrow(/nsfwLevel/);
    expect(update).not.toHaveBeenCalled();
  });

  it('counts a scheduled crucible whose start has passed as running, before the job flips it', async () => {
    findUnique.mockResolvedValue(upcoming({ startAt: new Date(Date.now() - 60_000) }));

    await expect(edit({ nsfwLevel: 3 })).rejects.toThrow(/nsfwLevel/);
    await expect(edit({ nsfwLevel: 3 }, 1, true)).rejects.toThrow(/nsfwLevel/);
    expect(update).not.toHaveBeenCalled();
  });

  it('never moves Buzz', async () => {
    await edit({ name: 'x', description: 'y' });
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});

describe('updateCrucible — while upcoming', () => {
  it('lets the owner change any setting', async () => {
    findUnique.mockResolvedValue(upcoming());
    await edit({ entryFee: 200, nsfwLevel: 3, entryLimit: 3 });
    expect(written()).toMatchObject({ entryFee: 200, nsfwLevel: 3, entryLimit: 3 });
  });

  it('refunds the old setup fee before charging the new one', async () => {
    findUnique.mockResolvedValue(upcoming({ buzzTransactionId: 'crucible-setup-4-old' }));

    await edit({ allowedResources: [10] });

    expect(refunded()).toEqual(['crucible-setup-4-old']);
    expect(charged()).toEqual([CRUCIBLE_RESOURCE_REQUIREMENTS_COST]);
    expect(refundMultiAccountTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      createMultiAccountBuzzTransaction.mock.invocationCallOrder[0]
    );
    expect(written().buzzTransactionId).toMatch(/^crucible-setup-4-(?!old)/);
  });

  it('refuses swapping in a model that is not published and public', async () => {
    findUnique.mockResolvedValue(upcoming({ allowedResources: [10] }));
    modelVersionCount.mockResolvedValue(0);

    await expect(edit({ allowedResources: [11] })).rejects.toThrow(/published, public model/);
    expect(modelVersionCount).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: { in: [11] } }),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('re-checks every required model against a new content type', async () => {
    findUnique.mockResolvedValue(upcoming({ allowedResources: [10] }));
    modelVersionFindMany.mockResolvedValue([{ baseModel: 'SDXL 1.0' }]);

    await expect(edit({ contentType: MediaType.video })).rejects.toThrow(/must make videos/);
    expect(modelVersionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [10] } } })
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('checks only newly added models when the content type stays', async () => {
    findUnique.mockResolvedValue(upcoming({ allowedResources: [10] }));
    modelVersionFindMany.mockImplementation(
      async ({ where }: { where: { id: { in: number[] } } }) =>
        where.id.in.map((id) => ({ baseModel: id === 10 ? 'MiniMax H3' : 'SDXL 1.0' }))
    );

    await edit({ name: 'Renamed' });
    expect(written()).toMatchObject({ name: 'Renamed' });

    await expect(edit({ allowedResources: [10, 12] })).resolves.toBeDefined();
    expect(modelVersionFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: { in: [12] } } })
    );
  });

  it("doesn't re-check the requirements of a crucible that has started", async () => {
    findUnique.mockResolvedValue(crucible({ allowedResources: [10] }));
    modelVersionFindMany.mockResolvedValue([{ baseModel: 'MiniMax H3' }]);

    await edit({ name: 'Renamed' });

    expect(modelVersionFindMany).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ name: 'Renamed' });
  });

  it('does not re-check a required model the crucible already had', async () => {
    findUnique.mockResolvedValue(upcoming({ allowedResources: [10] }));
    modelVersionCount.mockResolvedValue(0);

    await edit({ entryFee: 200 });

    expect(written()).toMatchObject({ entryFee: 200 });
  });

  it('asks the creator only for the difference', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );
    getUserBuzzAccount.mockResolvedValue([{ balance: 100, type: 'yellow' }]);

    await edit({ seededPrizePool: 1_100 });

    expect(charged()).toEqual([1_100]);
  });

  it('lets a moderator change the content levels before it starts', async () => {
    findUnique.mockResolvedValue(upcoming());
    await edit({ nsfwLevel: 3 }, 1, true);
    expect(written()).toMatchObject({ nsfwLevel: 3 });
  });

  it("keeps an upcoming crucible's settings with its owner, not a moderator", async () => {
    findUnique.mockResolvedValue(upcoming());
    await expect(edit({ entryFee: 300 }, 1, true)).rejects.toThrow(/entryFee/);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('re-charges only the seed when only the seed changes', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );

    await edit({ seededPrizePool: 3_000 });

    expect(charged()).toEqual([3_000]);
    expect(written()).toMatchObject({ seededPrizePool: 3_000 });
    expect(refunded()).toEqual(['crucible-seed-4-old']);
  });

  it('charges nothing when no paid option changes', async () => {
    findUnique.mockResolvedValue(upcoming());
    await edit({ name: 'Renamed', entryFee: 300 });
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('charges the original amount back and keeps the settings when the new charge fails', async () => {
    findUnique.mockResolvedValue(
      upcoming({ buzzTransactionId: 'crucible-setup-4-old', prizePositions: { '1': 70, '2': 30 } })
    );
    createMultiAccountBuzzTransaction.mockRejectedValueOnce(new Error('buzz down'));

    await expect(edit({ duration: 168 })).rejects.toThrow('buzz down');

    expect(refunded()).toEqual(['crucible-setup-4-old']);
    expect(charged()).toEqual([
      CRUCIBLE_DURATION_COSTS[168] + CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
      CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
    ]);
    const restoreWrite = dbMock.dbWrite.crucible.updateMany.mock.calls[0][0];
    expect(restoreWrite.where).toEqual({ id: 1, status: { not: CrucibleStatus.Cancelled } });
    expect(Object.keys(restoreWrite.data)).toEqual(['buzzTransactionId']);
    expect(update).not.toHaveBeenCalled();
  });

  it('refunds the restored charge when a cancel landed mid-edit', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );
    update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
        code: 'P2025',
        clientVersion: 'test',
      })
    );
    dbMock.dbWrite.crucible.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(edit({ seededPrizePool: 2_000 })).rejects.toThrow(
      /changed while you were editing/
    );

    // Old seed refunded, new one charged, new one refunded, old one charged back, then refunded.
    expect(charged()).toEqual([2_000, 1_000]);
    expect(refunded()).toHaveLength(3);
    expect(refunded()[2]).toBe(
      createMultiAccountBuzzTransaction.mock.calls[1][0].externalTransactionIdPrefix
    );
  });

  it('refunds the new charge and charges the original back when the write fails', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );
    update.mockRejectedValueOnce(new Error('db down'));

    await expect(edit({ seededPrizePool: 2_000 })).rejects.toThrow('db down');

    expect(charged()).toEqual([2_000, 1_000]);
    expect(refunded()).toEqual([
      'crucible-seed-4-old',
      expect.stringMatching(/^crucible-seed-4-(?!old)/),
    ]);
  });

  it('logs an original charge it could not put back', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );
    createMultiAccountBuzzTransaction.mockRejectedValue(new Error('buzz down'));

    await expect(edit({ seededPrizePool: 2_000 })).rejects.toThrow('buzz down');

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-edit-restore-failed',
        refunded: ['seed'],
      })
    );
  });

  it('writes only over the status it read, so a cancel since then is not revived', async () => {
    findUnique.mockResolvedValue(upcoming());

    await edit({ name: 'Renamed' });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, status: CrucibleStatus.Pending } })
    );
  });

  it('puts the charges back and says so when the crucible changed mid-edit', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );
    update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
        code: 'P2025',
        clientVersion: 'test',
      })
    );

    await expect(edit({ seededPrizePool: 2_000 })).rejects.toThrow(
      /changed while you were editing/
    );
    expect(charged()).toEqual([2_000, 1_000]);
  });

  it('keeps the stored prize pool equal to a changed seed, since nobody has paid in yet', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );

    await edit({ seededPrizePool: 2_000 });

    expect(written()).toMatchObject({ seededPrizePool: 2_000, prizePool: 2_000 });
  });

  it('moves the end with the start', async () => {
    findUnique.mockResolvedValue(upcoming());
    const startAt = new Date(Date.now() + 72 * HOUR);

    await edit({ startAt });

    expect(written()).toMatchObject({
      startAt,
      endAt: new Date(startAt.getTime() + 24 * HOUR),
      status: CrucibleStatus.Pending,
    });
  });

  it('refuses more prize places than the new entry cap allows', async () => {
    findUnique.mockResolvedValue(upcoming());
    await expect(edit({ maxTotalEntries: 2 })).rejects.toThrow(/more prize places/);
  });
});

describe('updateCrucible — free entries', () => {
  // Deliberately not moderator-only.
  it('lets an owner who is not a moderator set them on an upcoming crucible', async () => {
    findUnique.mockResolvedValue(upcoming({ entryLimit: 3 }));

    await edit({ freeEntriesPerUser: 2 });

    expect(written().freeEntriesPerUser).toBe(2);
  });

  it('keeps the free entries an edit leaves out', async () => {
    findUnique.mockResolvedValue(upcoming({ entryLimit: 3, freeEntriesPerUser: 1 }));

    await edit({ entryFee: 200 });

    expect(written()).toMatchObject({ entryFee: 200, freeEntriesPerUser: 1 });
  });

  it('refuses more free entries than the entry limit', async () => {
    findUnique.mockResolvedValue(upcoming({ entryLimit: 3 }));

    await expect(edit({ freeEntriesPerUser: 4 })).rejects.toThrow(
      'Free entries cannot exceed the entry limit per user'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an entry limit lowered below the free entries already set', async () => {
    findUnique.mockResolvedValue(upcoming({ entryLimit: 3, freeEntriesPerUser: 2 }));

    await expect(edit({ entryLimit: 1 })).rejects.toThrow(
      'Free entries cannot exceed the entry limit per user'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('locks them once the crucible has started', async () => {
    findUnique.mockResolvedValue(crucible({ entryLimit: 3 }));

    await expect(edit({ freeEntriesPerUser: 1 })).rejects.toThrow(
      /only its name, description and images can change/
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe('updateCrucible — content and images', () => {
  it('keeps a green crucible SFW', async () => {
    findUnique.mockResolvedValue(upcoming({ buzzType: 'green' }));
    await expect(edit({ nsfwLevel: 1 | 4 })).rejects.toThrow(/green Buzz crucible/);
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
    expect(written()).toMatchObject({ image: { connect: { id: 77 } } });
  });

  it('removes the hero image when sent null', async () => {
    await edit({ heroImage: null });
    expect(written()).toMatchObject({ heroImage: { disconnect: true } });
  });
});
