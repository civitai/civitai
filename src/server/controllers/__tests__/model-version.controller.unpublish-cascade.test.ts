import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unpublishing a model's last published version would otherwise leave the model published with
 * nothing under it — a state the model page, the listings and search all have to render, and one
 * nobody chose. The handler delegates to the model unpublish instead of doing both in turn.
 *
 * Scope note: `unpublishModelById` is mocked here, so this file is evidence about DELEGATION and
 * about the consent re-check — not about the refund gate itself, which is covered in
 * model-early-access-refund.service.test.ts.
 */

const {
  mockUnpublishModelById,
  mockUnpublishModelVersionById,
  mockGetVersionById,
  mockGetModel,
  mockResolveUnpublishScope,
  mockModelRequirement,
  mockVersionRequirement,
} = vi.hoisted(() => ({
  mockUnpublishModelById: vi.fn(),
  mockUnpublishModelVersionById: vi.fn(),
  mockGetVersionById: vi.fn(),
  mockGetModel: vi.fn(),
  mockResolveUnpublishScope: vi.fn(),
  mockModelRequirement: vi.fn(),
  mockVersionRequirement: vi.fn(),
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
vi.mock('~/server/services/model-early-access-refund.service', () => ({
  getModelEarlyAccessRefundRequirement: mockModelRequirement,
  getModelVersionEarlyAccessRefundRequirement: mockVersionRequirement,
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
      track: { modelVersionEvent: vi.fn(), modelEvent: vi.fn() },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVersionById.mockResolvedValue({ id: VERSION_ID, meta: null, modelId: MODEL_ID });
  mockGetModel.mockResolvedValue({ meta: null, nsfw: true, status: 'Published' });
  mockUnpublishModelVersionById.mockResolvedValue({
    id: VERSION_ID,
    model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
  });
  mockResolveUnpublishScope.mockResolvedValue({ kind: 'model', modelId: MODEL_ID });
  // Reset the implementation, not just the calls: vi.clearAllMocks() leaves a mockRejectedValue in
  // place, so the refusal test below would otherwise poison every test declared after it.
  mockUnpublishModelById.mockResolvedValue(undefined);
  mockModelRequirement.mockResolvedValue({ totalBuzz: 900 });
  mockVersionRequirement.mockResolvedValue({ totalBuzz: 300 });
});

describe('unpublishModelVersionHandler — last published version', () => {
  it('takes the model down with it, and does not also unpublish the version separately', async () => {
    await call({ refundEarlyAccess: true, expected: { scope: 'model', totalBuzz: 900 } });

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

  it('carries the moderator flag and the reason through to the model unpublish', async () => {
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

  // 🔴 On the preserve path the service writes back exactly what this controller hands it, so the
  // hand-off is load-bearing for the whole guard: `meta: {}` here erases the moderator's reason,
  // explanation, timestamp and actor while leaving the status at UnpublishedViolation — record
  // gone, flag intact.
  it('hands the model meta through intact', async () => {
    const moderatorRecord = {
      unpublishedReason: 'other',
      customMessage: 'Reviewed by a human',
      unpublishedAt: '2020-01-01T00:00:00.000Z',
      unpublishedBy: 999,
    };
    mockGetModel.mockResolvedValue({ meta: { ...moderatorRecord }, nsfw: true });

    await call();

    expect(mockUnpublishModelById).toHaveBeenCalledWith(
      expect.objectContaining({ meta: moderatorRecord })
    );
  });

  it('does not report a version take-down as a model unpublish', async () => {
    // The doubled-count shape: emitting the model event on the version path too would make every
    // single-version take-down arrive in analytics as a model unpublish.
    mockResolveUnpublishScope.mockResolvedValue({ kind: 'version', modelId: MODEL_ID });
    const modelEvent = vi.fn();

    await unpublishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: {
        user: { id: OWNER_ID, isModerator: false },
        track: { modelVersionEvent: vi.fn(), modelEvent },
      },
    } as never);

    expect(modelEvent).not.toHaveBeenCalled();
  });

  it('throws rather than silently wiping the model meta when the model is gone', async () => {
    mockGetModel.mockResolvedValue(null);

    await expect(call()).rejects.toThrowError(/No model with id/);

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
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

  // `refundEarlyAccess: true` is a yes with no ceiling. Between pricing the dialog and confirming
  // it, a sibling can go down — widening a version take-down into a whole model, and debiting the
  // creator against a figure they never saw.
  it('refuses when the scope widened while the dialog was open', async () => {
    await expect(
      call({ refundEarlyAccess: true, expected: { scope: 'version', totalBuzz: 300 } })
    ).rejects.toThrowError(/takes the whole model with it/);

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
    expect(mockUnpublishModelVersionById).not.toHaveBeenCalled();
  });

  it('refuses when the refund owed grew beyond what was shown', async () => {
    await expect(
      call({ refundEarlyAccess: true, expected: { scope: 'model', totalBuzz: 500 } })
    ).rejects.toThrowError(/refund owed has changed/);

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
  });

  // Negative control: a check that refused whenever `expected` was present would block every
  // ordinary unpublish, and both assertions above would still pass.
  it('proceeds when the priced figure still holds', async () => {
    await call({ refundEarlyAccess: true, expected: { scope: 'model', totalBuzz: 900 } });

    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the debit shrank — the copy was pessimistic, nothing extra is taken', async () => {
    mockModelRequirement.mockResolvedValue({ totalBuzz: 100 });

    await call({ refundEarlyAccess: true, expected: { scope: 'model', totalBuzz: 900 } });

    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
  });

  it('proceeds on a version-scoped confirm, pricing the version and not the model', async () => {
    // The version branch of the check was never exercised. Pricing it against the MODEL total would
    // refuse legitimate version-only unpublishes whenever the model owes more — the common case.
    mockResolveUnpublishScope.mockResolvedValue({ kind: 'version', modelId: MODEL_ID });

    await call({ refundEarlyAccess: true, expected: { scope: 'version', totalBuzz: 300 } });

    expect(mockUnpublishModelVersionById).toHaveBeenCalledTimes(1);
    expect(mockModelRequirement).not.toHaveBeenCalled();
  });

  it('refuses when a version-scoped figure grew', async () => {
    mockResolveUnpublishScope.mockResolvedValue({ kind: 'version', modelId: MODEL_ID });
    mockVersionRequirement.mockResolvedValue({ totalBuzz: 400 });

    await expect(
      call({ refundEarlyAccess: true, expected: { scope: 'version', totalBuzz: 300 } })
    ).rejects.toThrowError(/refund owed has changed/);

    expect(mockUnpublishModelVersionById).not.toHaveBeenCalled();
  });

  it('requires the owner to say what they agreed to before moving Buzz', async () => {
    // Optional would make the check advisory: any caller omitting `expected` — a stale tab mid
    // deploy, the moderator modal, a direct tRPC call — gets an unbounded yes.
    await expect(call({ refundEarlyAccess: true })).rejects.toThrowError(
      /reopen the unpublish menu/
    );

    expect(mockUnpublishModelById).not.toHaveBeenCalled();
  });

  it('does not require it of a moderator, who bypasses the refund gate anyway', async () => {
    await call({ refundEarlyAccess: true, reason: 'duplicate' }, true);

    expect(mockUnpublishModelById).toHaveBeenCalledTimes(1);
  });

  it('still reports the take-down to analytics', async () => {
    const modelVersionEvent = vi.fn();
    const modelEvent = vi.fn();
    await unpublishModelVersionHandler({
      input: { id: VERSION_ID },
      ctx: {
        user: { id: OWNER_ID, isModerator: false },
        track: { modelVersionEvent, modelEvent },
      },
    } as never);

    // The cascade branch returns early; without explicit events a last-version take-down is
    // invisible to analytics, because unpublishModelById fires none of its own. Every field is
    // pinned: objectContaining on type alone left a wrong modelId and a hardcoded nsfw green.
    expect(modelVersionEvent).toHaveBeenCalledWith({
      type: 'Unpublish',
      modelVersionId: VERSION_ID,
      modelId: MODEL_ID,
      nsfw: true,
    });
    // The identical effect through unpublishModelHandler emits a model event, so a model unpublish
    // reached from the version menu must appear in the same count.
    expect(modelEvent).toHaveBeenCalledWith({
      type: 'Unpublish',
      modelId: MODEL_ID,
      nsfw: true,
    });
    expect(modelEvent).toHaveBeenCalledTimes(1);
    expect(modelVersionEvent).toHaveBeenCalledTimes(1);
  });
});
