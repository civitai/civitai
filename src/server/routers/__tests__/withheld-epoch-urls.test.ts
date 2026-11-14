import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelController from '~/server/controllers/model.controller';
import type * as ModelVersionController from '~/server/controllers/model-version.controller';
import type * as ServerDomain from '~/server/utils/server-domain';

/**
 * A deleted or taken-down model's training epoch urls (the orchestrator's links to its weights)
 * as each file surface shows them: withheld from everyone but moderators, the rest of each epoch
 * kept.
 */

const {
  getFilesByVersionIdHandler,
  getModelVersionHandler,
  getModelVersionForEditHandler,
  getModelHandler,
} = vi.hoisted(() => ({
  getFilesByVersionIdHandler: vi.fn(),
  getModelVersionHandler: vi.fn(),
  getModelVersionForEditHandler: vi.fn(),
  getModelHandler: vi.fn(),
}));

vi.mock('~/server/controllers/model-file.controller', () => ({
  getFilesByVersionIdHandler,
  createFileHandler: vi.fn(),
  deleteFileHandler: vi.fn(),
  hasOfficialFileOfSizeHandler: vi.fn(),
  restoreReplacedFileHandler: vi.fn(),
  updateFileHandler: vi.fn(),
  upsertFileHandler: vi.fn(),
}));
vi.mock('~/server/controllers/model-version.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionController>()),
  getModelVersionHandler,
  getModelVersionForEditHandler,
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  isRedCapableHost: (host: string | null | undefined) => host === 'civitai.red',
}));
vi.mock('~/server/controllers/model.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelController>()),
  getModelHandler,
}));

import { modelFileRouter } from '~/server/routers/model-file.router';
import { modelVersionRouter } from '~/server/routers/model-version.router';
import { modelRouter } from '~/server/routers/model.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { withoutEpochUrls } from '~/server/services/training-data-restricted.service';

const OWNER = 7;
const OTHER = 8;
const VERSION = 10;
const EPOCH_URL = 'https://orchestration.example.test/blobs/epoch-3.safetensors';

type ModelState = { status: string; mode: string | null };
const PUBLISHED: ModelState = { status: 'Published', mode: null };
const TAKEN_DOWN: ModelState = { status: 'Published', mode: 'TakenDown' };
const DELETED: ModelState = { status: 'Deleted', mode: null };

const trainingResults = () => ({
  version: 2,
  epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL, sampleImages: ['https://img.test/s.png'] }],
});
type File = { id: number; type: string; visibility: string; metadata: Record<string, any> };
// A published trained model's weights file can carry its run's results too.
const weights = (): File => ({
  id: 1,
  type: 'Model',
  visibility: 'Public',
  metadata: {
    format: 'SafeTensor',
    selectedEpochUrl: EPOCH_URL,
    trainingResults: trainingResults(),
  },
});
const dataset = (): File => ({
  id: 2,
  type: 'Training Data',
  visibility: 'Public',
  metadata: {
    shareDataset: false,
    selectedEpochUrl: EPOCH_URL,
    trainingResults: trainingResults(),
  },
});

type Viewer = { id: number; isModerator: boolean } | undefined;

function ctx(user: Viewer) {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: { host: 'civitai.com' } },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: user ? 0 : 60 },
    features: {},
    track: { modelFile: vi.fn(() => Promise.resolve()) },
  } as never;
}

/** Each surface: serve the files for a model in `state`, and read back the files the caller gets. */
const SURFACES: [string, (state: ModelState, user: Viewer) => Promise<File[]>][] = [
  [
    'modelFile.getByVersionId',
    async (state, user) => {
      // The model's state comes back only when the read selects it, as in prod.
      dbMock.dbRead.modelVersion.findUnique.mockImplementation((async (args: any) => ({
        model: {
          userId: OWNER,
          ...(args.select?.model?.select?.status ? { status: state.status } : {}),
          ...(args.select?.model?.select?.mode ? { mode: state.mode } : {}),
        },
      })) as never);
      getFilesByVersionIdHandler.mockResolvedValue({
        modelVersionId: VERSION,
        files: [weights(), dataset()],
      });
      const res = await modelFileRouter.createCaller(ctx(user)).getByVersionId({ id: VERSION });
      return res.files as File[];
    },
  ],
  [
    'modelVersion.getById',
    async (state, user) => {
      getModelVersionHandler.mockResolvedValue({
        id: VERSION,
        model: { user: { id: OWNER }, ...state },
        files: [weights(), dataset()],
      });
      const res = await modelVersionRouter
        .createCaller(ctx(user))
        .getById({ id: VERSION, withFiles: true });
      return res.files as unknown as File[];
    },
  ],
  [
    'model.getById',
    async (state, user) => {
      getModelHandler.mockResolvedValue({
        id: 1,
        user: { id: OWNER },
        ...state,
        modelVersions: [{ id: VERSION, files: [weights(), dataset()] }],
      });
      const res = await modelRouter.createCaller(ctx(user)).getById({ id: 1 });
      return res.modelVersions[0].files as unknown as File[];
    },
  ],
];

const epochsOf = (file: File | undefined) => file?.metadata?.trainingResults?.epochs ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  // The dataset listing check: unrestricted.
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    { id: 2, nsfwLevel: 1, fullyRated: true, restricted: false, virusScanResult: 'Success' },
  ] as never);
});

describe.each(SURFACES)('%s and a deleted or taken-down model', (_, read) => {
  it.each([
    ['taken down', TAKEN_DOWN],
    ['deleted', DELETED],
  ])('withholds every epoch url from its owner when %s, keeping the rest', async (__, state) => {
    const files = await read(state, { id: OWNER, isModerator: false });

    for (const file of files) {
      expect(file.metadata.selectedEpochUrl).toBeUndefined();
      expect(epochsOf(file)).toEqual([
        { epochNumber: 3, sampleImages: ['https://img.test/s.png'] },
      ]);
    }
    expect(files).toHaveLength(2);
  });

  it.each([
    ['an anonymous caller', undefined],
    ['a signed-in non-owner', { id: OTHER, isModerator: false }],
  ])('withholds the weights file epoch urls from %s', async (__, user) => {
    const files = await read(TAKEN_DOWN, user);
    const weightsFile = files.find((f) => f.id === 1);

    expect(weightsFile).toBeDefined();
    expect(JSON.stringify(weightsFile)).not.toContain(EPOCH_URL);
  });

  it('gives a moderator the stored metadata', async () => {
    const files = await read(TAKEN_DOWN, { id: 1, isModerator: true });

    expect(files.find((f) => f.id === 1)?.metadata).toEqual(weights().metadata);
    expect(files.find((f) => f.id === 2)?.metadata.selectedEpochUrl).toBe(EPOCH_URL);
    expect(epochsOf(files.find((f) => f.id === 2))[0].modelUrl).toBe(EPOCH_URL);
  });

  it("keeps the owner's epoch urls on a model that is neither", async () => {
    const files = await read(PUBLISHED, { id: OWNER, isModerator: false });

    for (const file of files) expect(epochsOf(file)[0].modelUrl).toBe(EPOCH_URL);
  });
});

describe('modelVersion.getByIdForEdit and a taken-down model', () => {
  async function readForEdit(user: { id: number; isModerator: boolean }) {
    // The ownership check, from either client.
    for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
      db.modelVersion.findUnique.mockResolvedValue({
        modelId: 1,
        model: { userId: OWNER },
      } as never);
      db.model.findUnique.mockResolvedValue({ userId: OWNER } as never);
      db.model.findFirst.mockResolvedValue({ userId: OWNER } as never);
    }
    getModelVersionForEditHandler.mockResolvedValue({
      id: VERSION,
      model: { user: { id: OWNER }, ...TAKEN_DOWN },
      files: [weights(), dataset()],
    });
    const res = await modelVersionRouter.createCaller(ctx(user)).getByIdForEdit({ id: VERSION });
    return res.files as unknown as File[];
  }

  it('withholds the epoch urls from its owner', async () => {
    for (const file of await readForEdit({ id: OWNER, isModerator: false })) {
      expect(file.metadata.selectedEpochUrl).toBeUndefined();
      expect(epochsOf(file)[0]).not.toHaveProperty('modelUrl');
    }
  });

  it('gives a moderator the epoch urls', async () => {
    const files = await readForEdit({ id: OTHER, isModerator: true });

    expect(epochsOf(files.find((f) => f.id === 2))[0].modelUrl).toBe(EPOCH_URL);
  });
});

describe('withoutEpochUrls', () => {
  // A Training Studio dataset placeholder holds its selected epoch as its own url until archived.
  it("drops a file's own url when it is an epoch url, and keeps any other url", () => {
    const placeholder = { url: EPOCH_URL, metadata: { selectedEpochUrl: EPOCH_URL } };
    const orchestratorOnly = {
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/x.safetensors',
      metadata: {},
    };
    const archived = { url: 'training-images/7/d.zip', metadata: { selectedEpochUrl: EPOCH_URL } };

    const [a, b, c] = withoutEpochUrls([placeholder, orchestratorOnly, archived]);

    expect(a.url).toBeUndefined();
    expect(b.url).toBeUndefined();
    expect(c.url).toBe('training-images/7/d.zip');
  });

  it('reads no model for a response whose files carry no epoch urls', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      model: { userId: OWNER, status: 'Published', mode: 'TakenDown' },
    } as never);
    getFilesByVersionIdHandler.mockResolvedValue({
      modelVersionId: VERSION,
      files: [{ id: 1, type: 'Model', visibility: 'Public', metadata: { format: 'SafeTensor' } }],
    });

    await modelFileRouter.createCaller(ctx(undefined)).getByVersionId({ id: VERSION });

    expect(dbMock.dbRead.modelVersion.findUnique).not.toHaveBeenCalled();
  });

  it('removes a legacy run epoch url and keeps the rest of the epoch', () => {
    const legacy = {
      metadata: {
        trainingResults: {
          epochs: [{ epoch_number: 2, model_url: EPOCH_URL, sample_images: [{ image_url: 'x' }] }],
        },
      },
    };

    expect(withoutEpochUrls([legacy])[0].metadata.trainingResults.epochs).toEqual([
      { epoch_number: 2, sample_images: [{ image_url: 'x' }] },
    ]);
  });

  // The files can come from a shared cache, so stripping in place would reach the next viewer.
  it('leaves the files it was given untouched', () => {
    const files = [weights(), dataset()];
    const before = structuredClone(files);

    withoutEpochUrls(files);

    expect(files).toEqual(before);
  });
});
