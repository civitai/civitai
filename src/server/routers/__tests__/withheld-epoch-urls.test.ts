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
    { id: 2, nsfwLevel: 1, fullyRated: true, restricted: false },
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

    expect(weightsFile?.metadata.selectedEpochUrl).toBeUndefined();
    expect(epochsOf(weightsFile)[0]).not.toHaveProperty('modelUrl');
  });

  it('gives a moderator the stored epoch urls', async () => {
    const files = await read(TAKEN_DOWN, { id: 1, isModerator: true });

    expect(epochsOf(files.find((f) => f.id === 2))[0].modelUrl).toBe(EPOCH_URL);
  });

  it("keeps the owner's epoch urls on a model that is neither", async () => {
    const files = await read(PUBLISHED, { id: OWNER, isModerator: false });

    for (const file of files) expect(epochsOf(file)[0].modelUrl).toBe(EPOCH_URL);
  });
});
