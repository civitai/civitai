import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ImageService from '~/server/services/image.service';
import type * as ReportService from '~/server/services/report.service';

/**
 * `report.router.ts`'s `createAppeal` uses `guardedProcedure` with no ownership
 * middleware, so the switch in `createEntityAppealHandler` is the only thing
 * standing between a user and appealing someone else's model. The BAD_REQUEST
 * gate is also what keeps the ~13,700 legacy minor flags (no `minorFlagSnapshot`)
 * off this path.
 */

const { mockModelFindUnique, mockModel3DFindUnique } = vi.hoisted(() => ({
  mockModelFindUnique: vi.fn(),
  mockModel3DFindUnique: vi.fn(),
}));

const {
  mockGetImageById,
  mockGetLatestModelAppeal,
  mockCreateEntityAppeal,
  mockReopenModelAppeal,
} = vi.hoisted(() => ({
  mockGetImageById: vi.fn(),
  mockGetLatestModelAppeal: vi.fn(),
  mockCreateEntityAppeal: vi.fn(),
  mockReopenModelAppeal: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    model: { findUnique: mockModelFindUnique },
    model3D: { findUnique: mockModel3DFindUnique },
  },
  dbWrite: {},
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
  createEntityAppeal: mockCreateEntityAppeal,
  reopenModelAppeal: mockReopenModelAppeal,
}));

import { createEntityAppealHandler } from '../report.controller';
import { EntityType } from '~/shared/utils/prisma/enums';

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
