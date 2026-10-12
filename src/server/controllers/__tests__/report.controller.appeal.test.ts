import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ReportService from '~/server/services/report.service';

const { mockGetImageById, mockGetLatestAppeal, mockCreateEntityAppeal, mockReopenAppeal } =
  vi.hoisted(() => ({
    mockGetImageById: vi.fn(),
    mockGetLatestAppeal: vi.fn(),
    mockCreateEntityAppeal: vi.fn(),
    mockReopenAppeal: vi.fn(),
  }));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImageById: mockGetImageById,
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  getLatestAppeal: mockGetLatestAppeal,
  createEntityAppeal: mockCreateEntityAppeal,
  reopenAppeal: mockReopenAppeal,
}));

import { createEntityAppealHandler } from '../report.controller';
import { EntityType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockModelFindUnique = dbMock.dbRead.model.findUnique;
const mockModel3DFindUnique = dbMock.dbRead.model3D.findUnique;

function ctxUser(id = 602767) {
  return { user: { id }, features: { isGreen: false } } as never;
}

const baseInput = {
  entityId: 2186217,
  entityType: EntityType.Model,
  message: 'This is my own character design.',
} as const;

const flaggedModel = { userId: 602767, minor: true, meta: { minorFlagSnapshot: {} } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLatestAppeal.mockResolvedValue(null);
  mockCreateEntityAppeal.mockResolvedValue({ id: 1 });
  mockReopenAppeal.mockResolvedValue({ id: 1, status: 'Pending' });
});

describe('createEntityAppealHandler — Model ownership + flag gates', () => {
  it('throws NOT_FOUND when the model does not exist', async () => {
    mockModelFindUnique.mockResolvedValue(null);

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws UNAUTHORIZED when the caller does not own the model', async () => {
    mockModelFindUnique.mockResolvedValue({
      userId: 999,
      minor: true,
      meta: { minorFlagSnapshot: {} },
    });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('throws BAD_REQUEST when the model is not flagged as minor', async () => {
    mockModelFindUnique.mockResolvedValue({
      userId: 602767,
      minor: false,
      meta: { minorFlagSnapshot: {} },
    });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('throws BAD_REQUEST when minor but the meta carries no minorFlagSnapshot (legacy flag)', async () => {
    mockModelFindUnique.mockResolvedValue({ userId: 602767, minor: true, meta: {} });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

/**
 * A model's minor-flag review request is reopened in place rather than recorded as a new
 * appeal, and asking again after a denial is allowed.
 */
describe('createEntityAppealHandler — Model re-request', () => {
  beforeEach(() => {
    mockModelFindUnique.mockResolvedValue(flaggedModel);
  });

  it('creates a new appeal when the owner has never asked', async () => {
    await createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) });

    expect(mockCreateEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 2186217, userId: 602767, skipFee: true })
    );
    expect(mockReopenAppeal).not.toHaveBeenCalled();
  });

  it('throws BAD_REQUEST when a request is already under review', async () => {
    mockGetLatestAppeal.mockResolvedValue({ id: 7, status: 'Pending', resolvedAt: null });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
    expect(mockReopenAppeal).not.toHaveBeenCalled();
  });

  it('reopens a rejected request rather than creating a second row', async () => {
    mockGetLatestAppeal.mockResolvedValue({ id: 7, status: 'Rejected', resolvedAt: new Date() });

    const result = await createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) });

    expect(mockGetLatestAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: EntityType.Model, entityId: 2186217, userId: 602767 })
    );
    expect(mockReopenAppeal).toHaveBeenCalledWith({ id: 7, message: baseInput.message });
    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'Pending' });
  });

  // An approved appeal unflags the model, but a later re-upload can flag it again.
  it('reopens an approved request when the model has been flagged again', async () => {
    mockGetLatestAppeal.mockResolvedValue({ id: 7, status: 'Approved', resolvedAt: new Date() });

    await createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) });

    expect(mockReopenAppeal).toHaveBeenCalled();
    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
  });
});

// Images and 3D models: one appeal per block, each recorded as its own row and charged as usual.
describe.each([
  {
    entityType: EntityType.Image,
    entityId: 99,
    owned: () =>
      mockGetImageById.mockResolvedValue({
        id: 99,
        userId: 602767,
        blockedFor: 'moderated',
        needsReview: null,
      }),
    allowedAfter: [null, 'Approved'],
    refusedAfter: ['Pending', 'Rejected'],
  },
  {
    entityType: EntityType.Model3D,
    entityId: 77,
    owned: () => mockModel3DFindUnique.mockResolvedValue({ userId: 602767, status: 'Unpublished' }),
    // Approving a 3D model appeal restores nothing, so the model is still under the same removal.
    allowedAfter: [null],
    refusedAfter: ['Pending', 'Rejected', 'Approved'],
  },
])(
  'createEntityAppealHandler — $entityType',
  ({ entityType, entityId, owned, allowedAfter, refusedAfter }) => {
    const appeal = () =>
      createEntityAppealHandler({
        input: { entityId, entityType, message: 'Please review again.' },
        ctx: ctxUser(602767),
      });

    beforeEach(() => owned());

    it('looks up this owner’s latest appeal on this entity', async () => {
      await appeal();

      expect(mockGetLatestAppeal).toHaveBeenCalledWith(
        expect.objectContaining({ entityType, entityId, userId: 602767 })
      );
    });

    it.each(allowedAfter)('creates a new charged appeal when the latest is %s', async (status) => {
      mockGetLatestAppeal.mockResolvedValue(status ? { id: 7, status } : null);

      await appeal();

      expect(mockCreateEntityAppeal).toHaveBeenCalledWith(
        expect.objectContaining({ entityType, entityId, skipFee: false })
      );
      expect(mockReopenAppeal).not.toHaveBeenCalled();
    });

    it.each(refusedAfter)(
      'refuses with BAD_REQUEST, before any charge, when the latest is %s',
      async (status) => {
        mockGetLatestAppeal.mockResolvedValue({ id: 7, status });

        await expect(appeal()).rejects.toMatchObject({ code: 'BAD_REQUEST' });

        expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
        expect(mockReopenAppeal).not.toHaveBeenCalled();
      }
    );
  }
);

describe('createEntityAppealHandler — Model3D eligibility', () => {
  it('refuses a 3D model that moderators have not removed, before any charge', async () => {
    mockModel3DFindUnique.mockResolvedValue({ userId: 602767, status: 'Published' });

    await expect(
      createEntityAppealHandler({
        input: { entityId: 77, entityType: EntityType.Model3D, message: 'Please review again.' },
        ctx: ctxUser(602767),
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Only a 3D model removed by moderators can be appealed',
    });
    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
  });
});

const poiEntry = { at: 'x', workflowId: 'wf-1', reason: 'Names a real actor.' };

describe('createEntityAppealHandler — Model text-scan poi', () => {
  it('accepts an appeal against an open text-scan poi flag', async () => {
    mockModelFindUnique.mockResolvedValue({
      userId: 602767,
      minor: false,
      poi: true,
      meta: { textScanFlags: { poi: poiEntry } },
    });
    await createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) });
    expect(mockCreateEntityAppeal).toHaveBeenCalledWith(expect.objectContaining({ skipFee: true }));
  });

  it('refuses a self-declared poi with no text-scan snapshot', async () => {
    mockModelFindUnique.mockResolvedValue({ userId: 602767, minor: false, poi: true, meta: {} });
    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('createEntityAppealHandler — Bounty', () => {
  const bountyInput = {
    entityId: 9,
    entityType: EntityType.Bounty,
    message: 'Fictional.',
  } as const;
  const mockBountyFindUnique = dbMock.dbRead.bounty.findUnique;
  const flaggedBounty = { userId: 602767, poi: true, meta: { textScanFlags: { poi: poiEntry } } };

  it('404s a missing bounty and refuses a non-owner', async () => {
    mockBountyFindUnique.mockResolvedValue(null);
    await expect(
      createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    mockBountyFindUnique.mockResolvedValue({ ...flaggedBounty, userId: 1 });
    await expect(
      createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a bounty with no open text-scan flag', async () => {
    mockBountyFindUnique.mockResolvedValue({ ...flaggedBounty, meta: null });
    await expect(
      createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('creates a fee-free appeal the first time', async () => {
    mockBountyFindUnique.mockResolvedValue(flaggedBounty);
    await createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() });
    expect(mockGetLatestAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: EntityType.Bounty, entityId: 9, userId: 602767 })
    );
    expect(mockCreateEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: EntityType.Bounty, entityId: 9, skipFee: true })
    );
  });

  it('refuses while one is pending, and reopens the row after a denial', async () => {
    mockBountyFindUnique.mockResolvedValue(flaggedBounty);
    mockGetLatestAppeal.mockResolvedValue({ id: 8, status: 'Pending', resolvedAt: null });
    await expect(
      createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    mockGetLatestAppeal.mockResolvedValue({ id: 8, status: 'Rejected', resolvedAt: new Date() });
    await createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() });
    expect(mockReopenAppeal).toHaveBeenCalledWith({ id: 8, message: 'Fictional.' });
    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
  });
});
