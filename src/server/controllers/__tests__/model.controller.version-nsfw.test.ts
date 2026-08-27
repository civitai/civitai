import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `getModelHandler` — the version switcher's NSFW filter.
 *
 * This is the surface the whole feature rests on. A version flagged NSFW by NAME is excluded
 * from its model's rollup, so the model stays SFW; every gate above this one reads model-level
 * values and therefore cannot catch it. In practice this filter is the ONLY thing keeping a
 * flagged version's name off the model page on civitai.com — the page's own gate reads
 * `model.nsfw` and never fires.
 *
 * Dropping the conjunct is green across the rest of the suite and renders the flagged string.
 *
 * The handler runs far past the filter, so rather than mocking its whole tail this observes the
 * FIRST use of `filteredVersions`: the `post.findMany` that takes their ids. Everything after
 * that point is allowed to fail — the assertion is on what the filter produced, which is
 * already decided by then.
 */

vi.mock('~/server/services/model.service', () => ({
  getModel: vi.fn(),
  copyGallerySettingsToAllModelsByUser: vi.fn(),
  deleteModelById: vi.fn(),
  getDraftModelsByUserId: vi.fn(),
  getGallerySettingsByModelId: vi.fn(),
  getModels: vi.fn(),
  getModelsRaw: vi.fn(),
  getModelsWithImagesAndModelVersions: vi.fn(),
  getModelVersionsMicro: vi.fn(),
  getPrivateModelCount: vi.fn(),
  getTrainingModelsByUserId: vi.fn(),
  getVaeFiles: vi.fn(),
  permaDeleteModelById: vi.fn(),
  privateModelFromTraining: vi.fn(),
  publishModelById: vi.fn(),
  publishPrivateModel: vi.fn(),
  restoreModelById: vi.fn(),
  setModelMinor: vi.fn(),
  setModelShowcaseCollection: vi.fn(),
  toggleCheckpointCoverage: vi.fn(),
  toggleLockModel: vi.fn(),
  unpublishModelById: vi.fn(),
  updateModelById: vi.fn(),
  queueModelEarlyAccessReindex: vi.fn(),
  upsertModel: vi.fn(),
}));

const { getModel } = await import('~/server/services/model.service');
const { getModelHandler } = await import('~/server/controllers/model.controller');

const version = (id: number, nsfw: boolean) => ({
  id,
  name: `v${id}`,
  nsfw,
  status: 'Published',
  publishedAt: new Date('2020-01-01'),
  availability: 'Public',
  usageControl: 'Allow',
  baseModel: 'SD 1.5',
  generationCoverage: { covered: true },
});

const model = (versions: ReturnType<typeof version>[]) => ({
  id: 3,
  name: 'A Model',
  status: 'Published',
  type: 'LORA',
  user: { id: 99, username: 'creator' },
  modelVersions: versions,
});

/** The ids the filter let through, read off the first consumer of `filteredVersions`. */
async function versionIdsReaching(
  versions: ReturnType<typeof version>[],
  ctx: { canViewNsfw: boolean; userId?: number; isModerator?: boolean }
) {
  vi.mocked(getModel).mockResolvedValue(model(versions) as never);

  await getModelHandler({
    input: { id: 3 } as never,
    ctx: {
      user: ctx.userId ? ({ id: ctx.userId, isModerator: ctx.isModerator } as never) : undefined,
      features: { canViewNsfw: ctx.canViewNsfw } as never,
    } as never,
    // The tail of the handler is out of scope; the filter has already run by the time it fails.
  }).catch(() => undefined);

  const call = dbMock.dbRead.post.findMany.mock.calls[0]?.[0] as
    | { where: { modelVersionId: { in: number[] } } }
    | undefined;
  return call?.where.modelVersionId.in;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.post.findMany.mockResolvedValue([]);
});

describe('getModelHandler — flagged versions on the SFW domain', () => {
  it('drops a flagged version for an anonymous viewer', async () => {
    const ids = await versionIdsReaching([version(1, false), version(2, true)], {
      canViewNsfw: false,
    });

    expect(ids).toEqual([1]);
  });

  it('keeps flagged versions where NSFW is viewable', async () => {
    const ids = await versionIdsReaching([version(1, false), version(2, true)], {
      canViewNsfw: true,
    });

    expect(ids).toEqual([1, 2]);
  });

  // The owner is editing their own model and has to see what they published, flagged or not.
  // `isOwner` short-circuits the whole filter, so this also pins that the flag was not bolted
  // on in a way that overrides the ownership branch.
  it('keeps flagged versions for the owner', async () => {
    const ids = await versionIdsReaching([version(1, false), version(2, true)], {
      canViewNsfw: false,
      userId: 99,
    });

    expect(ids).toEqual([1, 2]);
  });

  it('keeps flagged versions for a moderator', async () => {
    const ids = await versionIdsReaching([version(1, false), version(2, true)], {
      canViewNsfw: false,
      userId: 5,
      isModerator: true,
    });

    expect(ids).toEqual([1, 2]);
  });

  // The flag is one conjunct among three. A revert that drops it while leaving the publication
  // rules intact is the shape this file exists to catch, so prove the other two still bite.
  it('still drops unpublished and future-dated versions', async () => {
    const scheduled = { ...version(3, false), publishedAt: new Date('2999-01-01') };
    const draft = { ...version(4, false), status: 'Draft' };

    const ids = await versionIdsReaching(
      [version(1, false), version(2, true), scheduled, draft] as never,
      { canViewNsfw: false }
    );

    expect(ids).toEqual([1]);
  });
});
