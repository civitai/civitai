import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelController from '~/server/controllers/model.controller';
import type * as ModelVersionController from '~/server/controllers/model-version.controller';
import type * as ServerDomain from '~/server/utils/server-domain';

/**
 * A shared training dataset as each file surface shows it: `modelFile.getByVersionId`,
 * `modelVersion.getById` and `model.getById`. Anyone but the owner and moderators gets a dataset
 * only while it is Public and listable, and then without its metadata; the owner sees one
 * "not shared" state whatever kept the share Private. The listing query is the real one, answered
 * by the db mock.
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
const WEIGHTS = { id: 1, type: 'Model', visibility: 'Public', metadata: { format: 'SafeTensor' } };

const SERVER_ONLY = ['datasetArchive', 'nsfwLevel', 'fullyRated'];

type File = { id: number; type: string; visibility: string; metadata: Record<string, unknown> };

const dataset = (overrides: Partial<File> = {}): File => ({
  id: 2,
  type: 'Training Data',
  visibility: 'Public',
  metadata: {
    ownRights: true,
    shareDataset: true,
    selectedEpochUrl: 'https://example.test/epoch',
    datasetArchive: { status: 'archived', complete: true },
    nsfwLevel: 1,
    fullyRated: true,
  },
  ...overrides,
});

/** The listing query's answer for the dataset row. */
function listingRow(row: { nsfwLevel?: number; fullyRated?: boolean; restricted: boolean }) {
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    {
      id: 2,
      nsfwLevel: row.nsfwLevel ?? 1,
      fullyRated: row.fullyRated ?? true,
      restricted: row.restricted,
      virusScanResult: 'Success',
    },
  ]);
}

type Viewer = { id: number; isModerator: boolean } | undefined;

function ctx(user: Viewer, host = 'civitai.com') {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: { host } },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: user ? 0 : 60 },
    features: {},
    track: { modelFile: vi.fn(() => Promise.resolve()) },
  } as never;
}

/** Each surface: serve `files` from its handler, and read back the files the caller gets. */
const SURFACES: [string, (files: File[], user: Viewer, host?: string) => Promise<File[]>][] = [
  [
    'modelFile.getByVersionId',
    async (files, user, host) => {
      getFilesByVersionIdHandler.mockResolvedValue({ modelVersionId: VERSION, files });
      const res = await modelFileRouter
        .createCaller(ctx(user, host))
        .getByVersionId({ id: VERSION });
      return res.files as File[];
    },
  ],
  [
    'modelVersion.getById',
    async (files, user, host) => {
      getModelVersionHandler.mockResolvedValue({
        id: VERSION,
        model: { user: { id: OWNER } },
        files,
      });
      const res = await modelVersionRouter
        .createCaller(ctx(user, host))
        .getById({ id: VERSION, withFiles: true });
      return res.files as unknown as File[];
    },
  ],
  [
    'model.getById',
    async (files, user, host) => {
      getModelHandler.mockResolvedValue({
        id: 1,
        user: { id: OWNER },
        modelVersions: [{ id: VERSION, files }],
      });
      const res = await modelRouter.createCaller(ctx(user, host)).getById({ id: 1 });
      return res.modelVersions[0].files as unknown as File[];
    },
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({ model: { userId: OWNER } });
  listingRow({ restricted: false });
});

describe.each(SURFACES)('%s and a shared training dataset', (_, read) => {
  const others: [string, Viewer][] = [
    ['an anonymous caller', undefined],
    ['a signed-in non-owner', { id: OTHER, isModerator: false }],
  ];

  it.each(others)(
    'lists an unrestricted Public dataset to %s, without its metadata',
    async (__, user) => {
      const files = await read([WEIGHTS, dataset()], user);
      expect(files.map((f) => f.id)).toEqual([1, 2]);
      expect(files[1].visibility).toBe('Public');
      expect(files[1].metadata).toEqual({});
      expect(files[0].metadata).toEqual(WEIGHTS.metadata);
    }
  );

  it.each(others)('leaves a restricted Public dataset out for %s', async (__, user) => {
    listingRow({ restricted: true });
    const files = await read([WEIGHTS, dataset()], user);
    expect(files.map((f) => f.id)).toEqual([1]);
  });

  it('leaves a dataset that is not Public out for others', async () => {
    const files = await read([WEIGHTS, dataset({ visibility: 'Private' })], undefined);
    expect(files.map((f) => f.id)).toEqual([1]);
  });

  it('leaves a mature dataset out for others on civitai.com, and lists it on civitai.red', async () => {
    listingRow({ nsfwLevel: 4, restricted: false });
    expect((await read([WEIGHTS, dataset()], undefined)).map((f) => f.id)).toEqual([1]);
    expect((await read([WEIGHTS, dataset()], undefined, 'civitai.red')).map((f) => f.id)).toEqual([
      1, 2,
    ]);
  });

  it.each([
    ['its owner', { id: OWNER, isModerator: false }],
    ['a moderator', { id: OTHER, isModerator: true }],
  ])('keeps a mature, restricted dataset listed for %s on civitai.com', async (__, user) => {
    listingRow({ nsfwLevel: 4, restricted: true });
    const files = await read([WEIGHTS, dataset({ visibility: 'Private' })], user);
    expect(files.map((f) => f.id)).toEqual([1, 2]);
  });

  it('shows the owner the same not-shared state whatever kept the share Private', async () => {
    const owner = { id: OWNER, isModerator: false };
    const restricted = dataset({ visibility: 'Private' });
    const incomplete = dataset({
      visibility: 'Private',
      metadata: {
        ...dataset().metadata,
        datasetArchive: { status: 'archived', complete: false, skipped: 3 },
        fullyRated: false,
      },
    });
    const [a, b] = [await read([restricted], owner), await read([incomplete], owner)];
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({
      visibility: 'Private',
      metadata: { ownRights: true, shareDataset: true },
    });
    for (const key of SERVER_ONLY) expect(a[0].metadata).not.toHaveProperty(key);
  });

  it('gives a moderator the stored metadata', async () => {
    const files = await read([dataset()], { id: OTHER, isModerator: true });
    expect(files[0].metadata).toEqual(dataset().metadata);
  });
});

describe('modelVersion.getByIdForEdit and a shared training dataset', () => {
  async function readForEdit(files: File[], user: { id: number; isModerator: boolean }) {
    // The ownership check, from either client.
    for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
      db.modelVersion.findUnique.mockResolvedValue({ modelId: 1, model: { userId: OWNER } });
      db.model.findUnique.mockResolvedValue({ userId: OWNER });
      db.model.findFirst.mockResolvedValue({ userId: OWNER });
    }
    getModelVersionForEditHandler.mockResolvedValue({
      id: VERSION,
      model: { user: { id: OWNER } },
      files,
    });
    const res = await modelVersionRouter.createCaller(ctx(user)).getByIdForEdit({ id: VERSION });
    return res.files as unknown as File[];
  }

  it('gives the owner the not-shared state, without the server-only keys', async () => {
    const [file] = await readForEdit([dataset({ visibility: 'Private' })], {
      id: OWNER,
      isModerator: false,
    });
    expect(file).toMatchObject({
      visibility: 'Private',
      metadata: { ownRights: true, shareDataset: true },
    });
    for (const key of SERVER_ONLY) expect(file.metadata).not.toHaveProperty(key);
  });

  it('gives a moderator the stored metadata', async () => {
    const [file] = await readForEdit([dataset()], { id: OTHER, isModerator: true });
    expect(file.metadata).toEqual(dataset().metadata);
  });
});
