import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks';
import {
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
} from '~/shared/constants/crucible.constants';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as CoverImageService from '~/server/services/cover-image.service';

const throwOnBlockedUserContent = vi.fn();
const resolveCoverImageId = vi.fn();
const getUserBuzzAccount = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();

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

  it('lets a moderator change the content levels', async () => {
    await edit({ nsfwLevel: 3 }, 1, true);
    expect(written()).toMatchObject({ nsfwLevel: 3 });
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

  it('asks the creator only for the difference', async () => {
    findUnique.mockResolvedValue(
      upcoming({ seededPrizePool: 1_000, seedTransactionId: 'crucible-seed-4-old' })
    );
    getUserBuzzAccount.mockResolvedValue([{ balance: 100, type: 'yellow' }]);

    await edit({ seededPrizePool: 1_100 });

    expect(charged()).toEqual([1_100]);
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
    expect(update).toHaveBeenCalledTimes(1);
    expect(Object.keys(written())).toEqual(['buzzTransactionId']);
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
