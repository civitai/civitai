import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as ModelService from '~/server/services/model.service';

/**
 * `modelId` does not mean the same thing in every input on this router, and the ownership middleware
 * reads it by name. On `upsert` it names the model the write LANDS on and must be owned; on
 * `addLinkedComponent` it names the LINKED resource's model, which the caller is normally NOT the owner
 * of — linking a stranger's VAE or CLIP is the ordinary case.
 *
 * Driven through `createCaller` so the middleware WIRING is what decides. Asserting the guard functions
 * in isolation would not catch the regression this pins: re-attaching the strict guard to
 * `addLinkedComponent` kills third-party linking outright, and nothing else in the suite notices.
 */

const { mockGetVersionById, mockGetModel, mockAddLinkedComponent, mockUpsertModelVersion } =
  vi.hoisted(() => ({
    mockGetVersionById: vi.fn(),
    mockGetModel: vi.fn(),
    mockAddLinkedComponent: vi.fn(async () => ({ id: 1 })),
    mockUpsertModelVersion: vi.fn(async () => ({ id: 1 })),
  }));

vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getVersionById: mockGetVersionById,
  addLinkedComponent: mockAddLinkedComponent,
  upsertModelVersion: mockUpsertModelVersion,
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModel: mockGetModel,
}));

const { modelVersionRouter } = await import('~/server/routers/model-version.router');

const OWNER = 7;
const STRANGER = 99;
const HOST_MODEL = 100;
const LINKED_MODEL = 200;

const user = { id: OWNER, isModerator: false, tier: 'free', username: 'owner', onboarding: 0x1f };

const ctx = () =>
  ({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  // The host version belongs to the caller; the linked resource's model does not.
  mockGetVersionById.mockResolvedValue({ modelId: HOST_MODEL });
  mockGetModel.mockImplementation(async ({ id }: { id: number }) =>
    id === HOST_MODEL ? { userId: OWNER } : { userId: STRANGER }
  );
});

describe('modelVersion router — what `modelId` authorizes', () => {
  it('lets an owner link a component whose model belongs to someone else', async () => {
    const caller = modelVersionRouter.createCaller(ctx());

    await expect(
      caller.addLinkedComponent({
        id: 1,
        targetVersionId: 55,
        componentType: 'VAE',
        modelId: LINKED_MODEL,
        modelName: 'somebody elses vae',
        versionName: 'v1',
        isRequired: true,
      })
    ).resolves.toBeDefined();

    expect(
      mockAddLinkedComponent,
      'the middleware refused a link to a model the caller does not own — third-party linking is the ordinary case for VAE/CLIP/UNet'
    ).toHaveBeenCalled();
  });

  it('still refuses an upsert that moves a version onto a model the caller does not own', async () => {
    const caller = modelVersionRouter.createCaller(ctx());

    await expect(
      caller.upsert({
        id: 1,
        modelId: LINKED_MODEL,
        name: 'v1',
        baseModel: 'SDXL 1.0',
      } as never)
    ).rejects.toThrow();

    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
  });
});
