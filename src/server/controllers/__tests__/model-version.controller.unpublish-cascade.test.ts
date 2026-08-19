import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unpublishing a model's last published version would otherwise leave the model published with
 * nothing under it — a state the model page, the listings and search all have to render, and one
 * nobody chose. The handler delegates to the model unpublish instead of doing both in turn, so the
 * model-scoped refund gate decides before anything moves: a refusal cannot leave the version down
 * and the model up.
 */

const {
  mockUnpublishModelById,
  mockUnpublishModelVersionById,
  mockGetVersionById,
  mockGetModel,
  mockResolveUnpublishScope,
} = vi.hoisted(() => ({
  mockUnpublishModelById: vi.fn(),
  mockUnpublishModelVersionById: vi.fn(),
  mockGetVersionById: vi.fn(),
  mockGetModel: vi.fn(),
  mockResolveUnpublishScope: vi.fn(),
}));

vi.mock('~/server/services/model-version.service', () => ({
  getVersionById: mockGetVersionById,
  unpublishModelVersionById: mockUnpublishModelVersionById,
  resolveUnpublishScope: mockResolveUnpublishScope,
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
  mockResolveUnpublishScope.mockResolvedValue({ kind: 'model', modelId: MODEL_ID });
  // Reset the implementation, not just the calls: vi.clearAllMocks() leaves a mockRejectedValue in
  // place, so the refusal test below would otherwise poison every test declared after it.
  mockUnpublishModelById.mockResolvedValue(undefined);
});

describe('unpublishModelVersionHandler — last published version', () => {
  it('takes the model down with it, and does not also unpublish the version separately', async () => {
    await call({ refundEarlyAccess: true });

    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
    expect(mockUnpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MODEL_ID,
        refundEarlyAccess: true,
        userId: OWNER_ID,
        isModerator: false,
      })
    );
    // Delegated, not doubled: unpublishModelById already unpublishes every published version, and
    // running the version path too would take the refund gate twice over the same buyers.
    expect(mockUnpublishModelVersionById).not.toHaveBeenCalled();
  });

  it('carries the moderator flag through, so a mod take-down still bypasses the gate', async () => {
    await call({ reason: 'duplicate' }, true);

    expect(mockUnpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ isModerator: true, reason: 'duplicate' })
    );
  });

  // Negative control. Without it, a cascade that fired unconditionally — taking a whole model down
  // because one of its twelve versions was retired — passes every assertion above.
  it('leaves the model alone while another published version remains', async () => {
    mockResolveUnpublishScope.mockResolvedValue({ kind: 'version', modelId: MODEL_ID });

    await call();

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(mockUnpublishModelVersionById).toHaveBeenCalledWith(
      expect.objectContaining({ id: VERSION_ID })
    );
  });

  it('lets the model-level refund refusal through instead of unpublishing the version', async () => {
    const { TRPCError } = await import('@trpc/server');
    mockUnpublishModelById.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Cannot unpublish … without refunding buyers.',
      })
    );

    // A plain Error would be routed through throwDbError into a generic 500, and a bare
    // rejects.toThrow() would pass on either — so the matcher has to name the refusal.
    await expect(call()).rejects.toThrowError(/without refunding buyers/);

    expect(mockUnpublishModelVersionById).not.toHaveBeenCalled();
  });

  it('still reports the take-down to analytics', async () => {
    const track = vi.fn();
    await unpublishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: { user: { id: OWNER_ID, isModerator: false }, track: { modelVersionEvent: track } },
    } as never);

    // The cascade branch returns early; without an explicit event a last-version take-down is
    // invisible to analytics, because unpublishModelById fires no version event of its own.
    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Unpublish', modelVersionId: VERSION_ID })
    );
  });
});
