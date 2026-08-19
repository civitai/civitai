import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Unpublishing a model's last published version would otherwise leave the model published with
 * nothing under it — a state the model page, the listings and search all have to render, and one
 * nobody chose. The handler delegates to the model unpublish instead of doing both in turn, so the
 * model-scoped refund gate decides before anything moves: a refusal cannot leave the version down
 * and the model up.
 */

const { mockUnpublishModelById, mockUnpublishModelVersionById, mockGetVersionById, mockGetModel } =
  vi.hoisted(() => ({
    mockUnpublishModelById: vi.fn(),
    mockUnpublishModelVersionById: vi.fn(),
    mockGetVersionById: vi.fn(),
    mockGetModel: vi.fn(),
  }));

vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: mockGetVersionById,
  unpublishModelVersionById: mockUnpublishModelVersionById,
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: mockGetModel,
  queueModelEarlyAccessReindex: vi.fn(),
  unpublishModelById: mockUnpublishModelById,
}));
// Reached at import through the orchestrator caller, which throws without a token. Nothing on this
// path calls it.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
}));

import { unpublishModelVersionHandler } from '~/server/controllers/model-version.controller';

const VERSION_ID = 100;
const MODEL_ID = 42;
const OWNER_ID = 7;

const call = (input: Record<string, unknown> = {}, isModerator = false) =>
  unpublishModelVersionHandler({
    input: { id: VERSION_ID, ...input },
    ctx: {
      user: { id: OWNER_ID, isModerator },
      track: { modelVersionEvent: vi.fn() },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVersionById.mockResolvedValue({ id: VERSION_ID, meta: null, modelId: MODEL_ID });
  mockGetModel.mockResolvedValue({ meta: null });
  mockUnpublishModelVersionById.mockResolvedValue({
    id: VERSION_ID,
    model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
  });
});

describe('unpublishModelVersionHandler — last published version', () => {
  it('takes the model down with it, and does not also unpublish the version separately', async () => {
    dbMock.dbRead.modelVersion.count.mockResolvedValue(0);

    await call({ refundEarlyAccess: true });

    expect(mockUnpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MODEL_ID,
        refundEarlyAccess: true,
        userId: OWNER_ID,
        isModerator: false,
      })
    );
    // Delegated, not doubled: unpublishModelById already unpublishes every published version.
    expect(mockUnpublishModelVersionById).not.toHaveBeenCalled();
  });

  it('counts only OTHER published versions of the same model', async () => {
    dbMock.dbRead.modelVersion.count.mockResolvedValue(0);

    await call();

    expect(dbMock.dbRead.modelVersion.count).toHaveBeenCalledWith({
      where: { modelId: MODEL_ID, status: 'Published', id: { not: VERSION_ID } },
    });
  });

  // Negative control. Without it, a cascade that fired unconditionally — taking a whole model down
  // because one of its twelve versions was retired — passes every assertion above.
  it('leaves the model alone while another published version remains', async () => {
    dbMock.dbRead.modelVersion.count.mockResolvedValue(1);

    await call();

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(mockUnpublishModelVersionById).toHaveBeenCalledWith(
      expect.objectContaining({ id: VERSION_ID })
    );
  });

  it('lets the model-level refund refusal through instead of unpublishing the version', async () => {
    dbMock.dbRead.modelVersion.count.mockResolvedValue(0);
    mockUnpublishModelById.mockRejectedValue(new Error('without refunding buyers'));

    await expect(call()).rejects.toThrow();

    // The point of delegating: a refusal leaves both the model and the version published.
    expect(mockUnpublishModelVersionById).not.toHaveBeenCalled();
  });
});
