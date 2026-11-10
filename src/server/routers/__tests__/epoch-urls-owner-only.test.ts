import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelController from '~/server/controllers/model.controller';
import type * as ModelVersionController from '~/server/controllers/model-version.controller';

/**
 * A file's training epoch URLs (`selectedEpochUrl`, `trainingResults`) on the procedures that use
 * `ownerOnlyFileUrls`: the version's owner and moderators get them, nobody else does, whatever the
 * request asks for.
 */

const { getFilesByVersionIdHandler, getModelVersionHandler, getModelHandler } = vi.hoisted(() => ({
  getFilesByVersionIdHandler: vi.fn(),
  getModelVersionHandler: vi.fn(),
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

type File = { id: number; type: string; visibility: string; metadata: Record<string, unknown> };
// A trained model's weights file, as stored.
const weights = (): File => ({
  id: 1,
  type: 'Model',
  visibility: 'Public',
  metadata: {
    format: 'SafeTensor',
    fp: 'fp16',
    selectedEpochUrl: EPOCH_URL,
    trainingResults: { version: 2, epochs: [{ epochNumber: 3, modelUrl: EPOCH_URL }] },
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

const SURFACES: [string, (user: Viewer) => Promise<File[]>][] = [
  [
    'model.getById',
    async (user) => {
      getModelHandler.mockResolvedValue({
        id: 1,
        user: { id: OWNER },
        status: 'Published',
        mode: null,
        modelVersions: [{ id: VERSION, files: [weights()] }],
      });
      // No excludeTrainingData: the caller does not opt out.
      const res = await modelRouter.createCaller(ctx(user)).getById({ id: 1 });
      return res.modelVersions[0].files as unknown as File[];
    },
  ],
  [
    'modelVersion.getById',
    async (user) => {
      getModelVersionHandler.mockResolvedValue({
        id: VERSION,
        model: { user: { id: OWNER }, status: 'Published', mode: null },
        files: [weights()],
      });
      const res = await modelVersionRouter
        .createCaller(ctx(user))
        .getById({ id: VERSION, withFiles: true });
      return res.files as unknown as File[];
    },
  ],
  [
    'modelFile.getByVersionId',
    async (user) => {
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
        model: { userId: OWNER },
      } as never);
      getFilesByVersionIdHandler.mockResolvedValue({
        modelVersionId: VERSION,
        files: [weights()],
      });
      const res = await modelFileRouter.createCaller(ctx(user)).getByVersionId({ id: VERSION });
      return res.files as File[];
    },
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
});

describe.each(SURFACES)('%s', (_, read) => {
  it.each([
    ['an anonymous caller', undefined],
    ['a signed-in non-owner', { id: OTHER, isModerator: false }],
  ])('gives %s no epoch URLs, keeping the rest of the metadata', async (__, user) => {
    const [file] = await read(user);

    expect(file.metadata).toEqual({ format: 'SafeTensor', fp: 'fp16' });
  });

  it.each([
    ['the owner', { id: OWNER, isModerator: false }],
    ['a moderator', { id: 1, isModerator: true }],
  ])('gives %s the stored metadata', async (__, user) => {
    const [file] = await read(user);

    expect(file.metadata).toEqual(weights().metadata);
  });
});
