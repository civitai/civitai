import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ReportService from '~/server/services/report.service';

const {
  mockGetImageById,
  mockGetLatestModelAppeal,
  mockGetLatestEntityAppeal,
  mockCreateEntityAppeal,
  mockReopenModelAppeal,
  mockReopenEntityAppeal,
} = vi.hoisted(() => ({
  mockGetImageById: vi.fn(),
  mockGetLatestModelAppeal: vi.fn(),
  mockGetLatestEntityAppeal: vi.fn(),
  mockCreateEntityAppeal: vi.fn(),
  mockReopenModelAppeal: vi.fn(),
  mockReopenEntityAppeal: vi.fn(),
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
  getLatestModelAppeal: mockGetLatestModelAppeal,
  getLatestEntityAppeal: mockGetLatestEntityAppeal,
  createEntityAppeal: mockCreateEntityAppeal,
  reopenModelAppeal: mockReopenModelAppeal,
  reopenEntityAppeal: mockReopenEntityAppeal,
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
  mockGetLatestModelAppeal.mockResolvedValue(null);
  mockCreateEntityAppeal.mockResolvedValue({ id: 1 });
  mockReopenModelAppeal.mockResolvedValue({ id: 1, status: 'Pending' });
  mockGetLatestEntityAppeal.mockResolvedValue(null);
  mockReopenEntityAppeal.mockResolvedValue({ id: 2, status: 'Pending' });
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
 * `Appeal` is unique on (entityType, entityId, userId), so a second create for the
 * same owner+model raises P2002 — which is not a TRPCError and comes back to the
 * owner as a raw 500 on a child-safety restriction. Every request after the first
 * has to route through the existing row.
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
    expect(mockReopenModelAppeal).not.toHaveBeenCalled();
  });

  it('throws BAD_REQUEST when a request is already under review', async () => {
    mockGetLatestModelAppeal.mockResolvedValue({ status: 'Pending', resolvedAt: null });

    await expect(
      createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
    expect(mockReopenModelAppeal).not.toHaveBeenCalled();
  });

  it('reopens a rejected request rather than creating a second row', async () => {
    mockGetLatestModelAppeal.mockResolvedValue({ status: 'Rejected', resolvedAt: new Date() });

    const result = await createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) });

    expect(mockReopenModelAppeal).toHaveBeenCalledWith({
      entityId: 2186217,
      userId: 602767,
      message: baseInput.message,
    });
    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'Pending' });
  });

  // An approved appeal unflags the model, but a later re-upload can flag it again —
  // and the row from the first round still blocks the create.
  it('reopens an approved request when the model has been flagged again', async () => {
    mockGetLatestModelAppeal.mockResolvedValue({ status: 'Approved', resolvedAt: new Date() });

    await createEntityAppealHandler({ input: baseInput, ctx: ctxUser(602767) });

    expect(mockReopenModelAppeal).toHaveBeenCalled();
    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
  });
});

describe('createEntityAppealHandler — other entity types are untouched', () => {
  it('creates an Image appeal without consulting the Model appeal lookup', async () => {
    mockGetImageById.mockResolvedValue({ id: 99, userId: 602767 });

    await createEntityAppealHandler({
      input: { entityId: 99, entityType: EntityType.Image, message: 'Please review again.' },
      ctx: ctxUser(602767),
    });

    expect(mockGetLatestModelAppeal).not.toHaveBeenCalled();
    expect(mockReopenModelAppeal).not.toHaveBeenCalled();
    expect(mockCreateEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 99, skipFee: false })
    );
  });

  it('creates a Model3D appeal without consulting the Model appeal lookup', async () => {
    mockModel3DFindUnique.mockResolvedValue({ userId: 602767 });

    await createEntityAppealHandler({
      input: { entityId: 77, entityType: EntityType.Model3D, message: 'Please review again.' },
      ctx: ctxUser(602767),
    });

    expect(mockGetLatestModelAppeal).not.toHaveBeenCalled();
    expect(mockCreateEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 77, skipFee: false })
    );
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
  const bountyInput = { entityId: 9, entityType: EntityType.Bounty, message: 'Fictional.' } as const;
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
    expect(mockGetLatestEntityAppeal).toHaveBeenCalledWith({
      entityType: EntityType.Bounty,
      entityId: 9,
      userId: 602767,
    });
    expect(mockCreateEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: EntityType.Bounty, entityId: 9, skipFee: true })
    );
  });

  it('refuses while one is pending, and reopens the row after a denial', async () => {
    mockBountyFindUnique.mockResolvedValue(flaggedBounty);
    mockGetLatestEntityAppeal.mockResolvedValue({ status: 'Pending', resolvedAt: null });
    await expect(
      createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    mockGetLatestEntityAppeal.mockResolvedValue({ status: 'Rejected', resolvedAt: new Date() });
    await createEntityAppealHandler({ input: bountyInput, ctx: ctxUser() });
    expect(mockReopenEntityAppeal).toHaveBeenCalledWith({
      entityType: EntityType.Bounty,
      entityId: 9,
      userId: 602767,
      message: 'Fictional.',
    });
    expect(mockCreateEntityAppeal).not.toHaveBeenCalled();
  });
});
