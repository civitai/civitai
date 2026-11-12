import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Tests for the file-granular `addLinkedComponent`: link a specific already-uploaded
// file into a version, authorize the referenced file's owner, dedupe per file, and
// optionally remove the redundant local file to reclaim its bytes.

const { mockMarkReplaced, mockPreventLag } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  });
  return {
    mockMarkReplaced: vi.fn(),
    mockPreventLag: vi.fn(),
  };
});

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventModelVersionLag: mockPreventLag,
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({}));

vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: {},
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  updateModelLastVersionAt: vi.fn(),
}));
const { mockFindOfficialFileByHash } = vi.hoisted(() => ({ mockFindOfficialFileByHash: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  markFileReplaced: mockMarkReplaced,
  findOfficialFileByHash: mockFindOfficialFileByHash,
}));
// Keep the real paid-access module (which reads REDIS_KEYS.CACHES.PAID_ACCESS at import) out of the graph.
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  writePaidAccessForModelVersion: vi.fn(),
  materializePaidAccessEndsAt: vi.fn(),
  bustPaidAccessCache: vi.fn(),
  paidAccessInputFromLegacyConfig: vi.fn(() => null),
  earlyAccessDonationGoalFromLegacyConfig: vi.fn(() => null),
  earlyAccessConfigFromPaidAccess: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));

import {
  addLinkedComponent,
  linkOfficialFileByHash,
  setLinkedComponents,
} from '~/server/services/model-version.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { constants } from '~/server/common/constants';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const CALLER = 100;

// A file owned by the caller, living on its parent version 777.
const ownFile = {
  id: 555,
  name: 'boogu.vae.safetensors',
  sizeKB: 300_000,
  type: 'VAE',
  metadata: null,
  modelVersionId: 777,
  modelVersion: { model: { userId: CALLER } },
};

const baseInput = {
  id: 10, // edited (source) version
  targetVersionId: 777, // canonical version
  componentType: 'VAE' as const,
  modelId: 20,
  modelName: 'Boogu VAE',
  versionName: 'v1',
  isRequired: true,
  userId: CALLER,
  isModerator: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.recommendedResource.findFirst.mockResolvedValue(null);
  mockDbWrite.recommendedResource.create.mockResolvedValue({ id: 1 });
  mockDbWrite.recommendedResource.update.mockResolvedValue({ id: 1 });
  mockDbWrite.modelVersion.findUnique.mockResolvedValue({ modelId: 99 });
});

describe('addLinkedComponent with targetFileId', () => {
  it('links the explicitly chosen file (not the auto-picked primary)', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);

    const result = await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    expect(mockDbRead.modelFile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 555 } })
    );
    // never falls back to auto-pick when an explicit file is given
    expect(mockDbRead.modelFile.findMany).not.toHaveBeenCalled();

    const createArg = mockDbWrite.recommendedResource.create.mock.calls[0][0];
    expect(createArg.data.settings.fileId).toBe(555);
    // resourceId is taken authoritatively from the file's parent version
    expect(createArg.data.resourceId).toBe(777);
    expect(result.fileId).toBe(555);
  });

  it('rejects with FORBIDDEN when the caller does not own the referenced file', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      ...ownFile,
      modelVersion: { model: { userId: 999 } },
    });

    await expect(addLinkedComponent({ ...baseInput, targetFileId: 555 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it('allows a moderator to link a file they do not own', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      ...ownFile,
      modelVersion: { model: { userId: 999 } },
    });

    await addLinkedComponent({ ...baseInput, targetFileId: 555, isModerator: true });

    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the referenced file does not exist', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(null);

    await expect(addLinkedComponent({ ...baseInput, targetFileId: 555 })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it('dedupes per file id so two files from one version coexist', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);

    await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    const where = mockDbWrite.recommendedResource.findFirst.mock.calls[0][0].where;
    // the dedupe lookup must constrain on the specific fileId, not just
    // (sourceId, resourceId) — otherwise a second file overwrites the first
    expect(where).toMatchObject({
      sourceId: baseInput.id,
      AND: expect.arrayContaining([{ settings: { path: ['fileId'], equals: 555 } }]),
    });
  });

  it('updates the existing row instead of creating when the same file is already linked', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);
    mockDbWrite.recommendedResource.findFirst.mockResolvedValue({ id: 7 });

    await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    expect(mockDbWrite.recommendedResource.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    );
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });
});

describe('addLinkedComponent with replaceFileId (dedup / byte reclaim)', () => {
  // replaceFileId is a component file living on the edited version (id 10).
  const replaceFile = { id: 888, name: 'old.vae', modelVersionId: 10, type: 'VAE' };

  const findUniqueByFile = (files: Record<number, unknown>) =>
    mockDbRead.modelFile.findUnique.mockImplementation(({ where }: { where: { id: number } }) =>
      Promise.resolve(files[where.id] ?? null)
    );

  it('deletes the redundant local file after the link is created', async () => {
    findUniqueByFile({ 555: ownFile, 888: replaceFile });

    await addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 });

    expect(mockMarkReplaced).toHaveBeenCalledWith({ fileId: 888, recommendedResourceId: 1 });
    // link must be created before the redundant file is removed
    const createOrder = mockDbWrite.recommendedResource.create.mock.invocationCallOrder[0];
    const deleteOrder = mockMarkReplaced.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);
  });

  it('rejects a replaceFileId that belongs to a different version', async () => {
    findUniqueByFile({ 555: ownFile, 888: { ...replaceFile, modelVersionId: 999 } });

    await expect(
      addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockMarkReplaced).not.toHaveBeenCalled();
  });

  it('rejects replacing a primary Model file (never delete the version weights)', async () => {
    findUniqueByFile({ 555: ownFile, 888: { ...replaceFile, type: 'Model' } });

    await expect(
      addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockMarkReplaced).not.toHaveBeenCalled();
  });

  it('rejects replacing primary-weights file types beyond Model (Diffusion Model, UNet) + Training Data', async () => {
    for (const type of ['Diffusion Model', 'UNet', 'Training Data']) {
      mockMarkReplaced.mockClear();
      findUniqueByFile({ 555: ownFile, 888: { ...replaceFile, type } });
      await expect(
        addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockMarkReplaced).not.toHaveBeenCalled();
    }
  });

  it('rejects a targetVersionId that does not match the targetFileId parent version', async () => {
    // ownFile lives on version 777; a caller-provided targetVersionId of 999 would
    // produce inconsistent denormalized data, so it is rejected.
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);
    await expect(
      addLinkedComponent({ ...baseInput, targetFileId: 555, targetVersionId: 999 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('does not delete anything when replaceFileId is absent', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);

    await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    expect(mockMarkReplaced).not.toHaveBeenCalled();
  });
});

describe('addLinkedComponent auto-pick (no targetFileId — public path unchanged)', () => {
  it('picks the primary file by modelFileOrder', async () => {
    mockDbRead.modelFile.findMany.mockResolvedValue([
      { id: 2, name: 'extra.vae', sizeKB: 100, type: 'VAE', metadata: null },
      { id: 9, name: 'main.safetensors', sizeKB: 200, type: 'Model', metadata: null },
    ]);

    const result = await addLinkedComponent({ ...baseInput });

    expect(mockDbRead.modelFile.findUnique).not.toHaveBeenCalled();
    const createArg = mockDbWrite.recommendedResource.create.mock.calls[0][0];
    expect(createArg.data.settings.fileId).toBe(9);
    expect(result.fileId).toBe(9);
  });
});

describe('linking a component to a live version of a pre-publish-review base model', () => {
  /**
   * The edited (source) version as its lock reads it, and which link targets the target rule's
   * query allows (that SQL is covered against Postgres in publish-guard.sql.behavior.test.ts).
   */
  const source = (status: string, baseModel = 'Fibo 2.0', allowedTargets = [777, 31]) =>
    mockDbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FOR SHARE')
        ? [{ status, baseModel }]
        : allowedTargets.map((id) => ({ id }))) as never);
  const REFUSED = /Create a new version/;

  beforeEach(() => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);
    mockDbWrite.recommendedResource.findMany.mockResolvedValue([]);
    // The caller's own file on version 777, as the ownership check reads it.
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      { id: 555, modelVersionId: 777, modelVersion: { model: { userId: CALLER } } },
    ] as never);
  });

  const add = (isModerator = false) =>
    addLinkedComponent({ ...baseInput, targetFileId: 555, isModerator });
  const set = (isModerator = false) =>
    setLinkedComponents({
      id: 10,
      components: [{ resourceId: 777, settings: { isLinkedComponent: true, fileId: 555 } }],
      userId: CALLER,
      isModerator,
    } as never);

  it.each(['Published', 'Scheduled'])(
    "refuses the owner's add on a %s Fibo 2.0 version",
    async (status) => {
      source(status);
      await expect(add()).rejects.toThrowError(REFUSED);
      expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
    }
  );

  it("refuses the owner's replace of a file with a link on a published Fibo 2.0 version", async () => {
    source('Published');
    // The target file to link, and the source version's own VAE file it replaces.
    mockDbRead.modelFile.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => (where.id === 9 ? { modelVersionId: 10, type: 'VAE' } : ownFile)) as never);
    await expect(
      addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 9 })
    ).rejects.toThrowError(REFUSED);
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it("refuses the owner's set on a published Fibo 2.0 version", async () => {
    source('Published');
    await expect(set()).rejects.toThrowError(REFUSED);
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a moderator, on a published Fibo 2.0 version', 'Published', 'Fibo 2.0', true],
    ['the owner, on a draft Fibo 2.0 version', 'Draft', 'Fibo 2.0', false],
    ['the owner, on a published version of another base model', 'Published', 'SDXL 1.0', false],
  ])('lets %s add and set links (control)', async (_l, status, baseModel, isModerator) => {
    source(status, baseModel);
    await add(isModerator);
    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalledTimes(1);
    await set(isModerator);
    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalledTimes(2);
  });
});

describe('setLinkedComponents — which rows and files an owner may write', () => {
  const OTHER_VERSIONS_ROW = 42;
  beforeEach(() => {
    // Off the gated base, so only row scope and file ownership are in play here.
    mockDbWrite.$queryRaw.mockResolvedValue([{ status: 'Draft', baseModel: 'SDXL 1.0' }] as never);
    // Version 10's own link rows: one, id 7, to file 555.
    mockDbWrite.recommendedResource.findMany.mockResolvedValue([
      { id: 7, settings: { isLinkedComponent: true, fileId: 555 } },
    ] as never);
    mockDbWrite.recommendedResource.updateMany.mockImplementation((async ({
      where,
    }: {
      where: { id: number; sourceId: number };
    }) => {
      // Row 7 is version 10's; row 42 is another version's. Matches as Postgres would.
      const sourceOf: Record<number, number> = { 7: 10, [OTHER_VERSIONS_ROW]: 11 };
      const source = sourceOf[where.id];
      return { count: source !== undefined && (where.sourceId ?? source) === source ? 1 : 0 };
    }) as never);
    mockDbWrite.modelFile.findMany.mockImplementation((async ({
      where,
    }: {
      where: { id: { in: number[] } };
    }) =>
      [
        { id: 555, modelVersionId: 777, modelVersion: { model: { userId: CALLER } } },
        { id: 666, modelVersionId: 888, modelVersion: { model: { userId: 999 } } },
      ].filter((f) => where.id.in.includes(f.id))) as never);
  });
  const set = (
    components: { id?: number; resourceId: number; fileId: number }[],
    isModerator = false
  ) =>
    setLinkedComponents({
      id: 10,
      components: components.map(({ id, resourceId, fileId }) => ({
        id,
        resourceId,
        settings: { isLinkedComponent: true, fileId, componentType: 'VAE' },
      })),
      userId: CALLER,
      isModerator,
    } as never);

  it("refuses an update naming another version's link row, and leaves it as it was", async () => {
    await expect(
      set([{ id: OTHER_VERSIONS_ROW, resourceId: 777, fileId: 555 }])
    ).rejects.toThrowError(/not on this version/);
    expect(mockDbWrite.recommendedResource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_VERSIONS_ROW, sourceId: 10 } })
    );
  });

  it("updates the version's own link row (control)", async () => {
    await set([{ id: 7, resourceId: 777, fileId: 555 }]);
    expect(mockDbWrite.recommendedResource.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses the owner's new link to a file they do not own", async () => {
    await expect(set([{ resourceId: 888, fileId: 666 }])).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it('refuses a file that is not on the version the link names', async () => {
    await expect(set([{ resourceId: 888, fileId: 555 }])).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it("lets the owner link their own file, and a moderator link anyone's (control)", async () => {
    await set([{ resourceId: 777, fileId: 555 }]);
    await set([{ resourceId: 888, fileId: 666 }], true);
    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalledTimes(2);
  });

  it('keeps an unchanged link to a file the owner does not own, such as an official one (control)', async () => {
    mockDbWrite.recommendedResource.findMany.mockResolvedValue([
      { id: 7, settings: { isLinkedComponent: true, fileId: 666 } },
    ] as never);
    await set([{ id: 7, resourceId: 888, fileId: 666 }]);
    expect(mockDbWrite.recommendedResource.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('linkOfficialFileByHash onto a live version of a pre-publish-review base model', () => {
  const OFFICIAL_FILE = {
    ...ownFile,
    id: 4242,
    modelVersionId: 31,
    modelVersion: { model: { userId: constants.system.officialUserId } },
  };
  beforeEach(() => {
    mockFindOfficialFileByHash.mockResolvedValue({
      versionId: 31,
      fileId: 4242,
      componentType: 'VAE',
      modelId: 30,
      modelName: 'Official VAE',
      versionName: 'v1',
    });
    mockDbRead.modelFile.findUnique.mockResolvedValue(OFFICIAL_FILE as never);
  });
  // The official version 31 is an allowed target.
  const source = (status: string) =>
    mockDbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FOR SHARE')
        ? [{ status, baseModel: 'Fibo 2.0' }]
        : [{ id: 31 }]) as never);
  const link = (isModerator: boolean) =>
    linkOfficialFileByHash({
      id: 10,
      sha256: 'ab'.repeat(32),
      userId: CALLER,
      isModerator,
    } as never);

  it("refuses the owner's link on a published Fibo 2.0 version", async () => {
    source('Published');
    await expect(link(false)).rejects.toThrowError(/Create a new version/);
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a moderator, on a published Fibo 2.0 version', 'Published', true],
    ['the owner, on a draft Fibo 2.0 version', 'Draft', false],
  ])('links the official file for %s (control)', async (_l, status, isModerator) => {
    source(status);
    await link(isModerator);
    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalledTimes(1);
  });
});

describe('the targets a version on a pre-publish-review base model may link to', () => {
  const draftLinking = (allowedTargets: number[]) =>
    mockDbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      strings.join('?').includes('FOR SHARE')
        ? [{ status: 'Draft', baseModel: 'Fibo 2.0' }]
        : allowedTargets.map((id) => ({ id }))) as never);
  beforeEach(() => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);
    mockDbWrite.recommendedResource.findMany.mockResolvedValue([]);
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      { id: 555, modelVersionId: 777, modelVersion: { model: { userId: CALLER } } },
    ] as never);
  });

  it('refuses an add, and a set, whose target the rule does not allow, on a draft', async () => {
    draftLinking([]);
    await expect(addLinkedComponent({ ...baseInput, targetFileId: 555 })).rejects.toThrowError(
      /official components or other reviewed versions/
    );
    await expect(
      setLinkedComponents({
        id: 10,
        components: [{ resourceId: 777, settings: { isLinkedComponent: true, fileId: 555 } }],
        userId: CALLER,
      } as never)
    ).rejects.toThrowError(/official components or other reviewed versions/);
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it('links an allowed target on a draft (control)', async () => {
    draftLinking([777]);
    await addLinkedComponent({ ...baseInput, targetFileId: 555 });
    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalledTimes(1);
  });

  it('lets a moderator link any target (control)', async () => {
    draftLinking([]);
    await addLinkedComponent({ ...baseInput, targetFileId: 555, isModerator: true });
    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalledTimes(1);
  });
});
