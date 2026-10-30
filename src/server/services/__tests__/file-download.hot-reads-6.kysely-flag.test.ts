import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FileService from '../file.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import * as queries from '@civitai/db-queries/hot-reads-6';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

/**
 * The download path's file list (`getFileForModelVersion`) behind `kysely-hot-reads-6`, on its two
 * paths (by file id, and by type). OFF: the Prisma read on the replica, with the same `where` as
 * before. ON: the Kysely read on the replica, whose file is the one resolved (the Prisma stub holds
 * a different one). The module setup below is file-download-lookup.test.ts's.
 */

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads6>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
vi.mock('@prisma/client', () => {
  const validator = () => (x: unknown) => x;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
    sql: strings.join('?'),
  });
  const raw = (s: string) => ({ sql: s, values: [] });
  const join = (values: unknown[], separator = ',') => ({ values, separator });
  const empty = { sql: '', values: [] };
  class Sql {}
  const known: Record<string, unknown> = {
    validator,
    sql,
    raw,
    join,
    empty,
    Sql,
    SortOrder: { asc: 'asc', desc: 'desc' },
    QueryMode: { default: 'default', insensitive: 'insensitive' },
    JsonNull: 'JsonNull',
    DbNull: 'DbNull',
    AnyNull: 'AnyNull',
  };
  const Prisma = new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return {};
    },
  });
  return new Proxy(
    { Prisma, PrismaClient: class PrismaClient {} },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        if (prop === '__esModule') return true;
        return {};
      },
    }
  );
});

const modelVersionFindFirst = dbMock.dbRead.modelVersion.findFirst;
const modelFileFindMany = dbMock.dbRead.modelFile.findMany;
const modelFileFindFirst = dbMock.dbRead.modelFile.findFirst;
const recommendedResourceFindFirst = dbMock.dbRead.recommendedResource.findFirst;

// Entity-access check: grant access by default so the happy path reaches the
// file lookup + URL resolution.
const hasEntityAccessMock = vi.fn();
vi.mock('../common.service', () => ({
  hasEntityAccess: hasEntityAccessMock,
}));

// file.service imports getBountyEntryFilteredFiles from bountyEntry.service,
// which transitively pulls image.service → ../../../event-engine-common/feeds
// (a separate workspace package not resolvable from this import chain). It's
// only used by getFilesForModelVersion, NOT the getFileForModelVersion lookup
// under test — stub it so the module graph loads.
vi.mock('~/server/services/bountyEntry.service', () => ({
  getBountyEntryFilteredFiles: vi.fn(),
}));

// getFileForModelVersion sources the EA gate from getPaidAccess. Defaults to no gate so the lookup
// runs unblocked; the access-denial tests below drive an active gate through it.
const getPaidAccessMock = vi.fn();
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: getPaidAccessMock,
  bustModelSaleCache: vi.fn(),
}));

// Control whether the delivery URL resolves. A throw here is the
// "genuinely unresolvable URL" case the fix must turn into a 404 (`not-found`),
// NOT a 500 (`error`).
const resolveDownloadUrlMock = vi.fn();
vi.mock('~/utils/delivery-worker', () => ({
  resolveDownloadUrl: resolveDownloadUrlMock,
}));

function publishedModelVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: 'Published',
    model: {
      id: 10,
      name: 'Test Model',
      type: 'Checkpoint',
      publishedAt: new Date(),
      status: 'Published',
      userId: 999,
      mode: null,
      nsfw: false,
      availability: 'Public',
      poi: false,
    },
    name: 'v1',
    trainedWords: [],
    earlyAccessEndsAt: null,
    earlyAccessConfig: null,
    createdAt: new Date(),
    requireAuth: false,
    usageControl: 'Download',
    ...overrides,
  };
}

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const FLAG = 'kysely-hot-reads-6';
const setFlag = (on: boolean) => flag.mockImplementation(async (key) => on && key === FLAG);

const offFile = {
  id: 9455,
  url: 'https://files.example/off.safetensors',
  name: 'off.safetensors',
  overrideName: null,
  type: 'Model',
  metadata: { format: 'SafeTensor' },
  sizeKB: 10,
  hashes: [{ hash: 'off' }],
};
const onFile = {
  ...offFile,
  id: 9456,
  url: 'https://files.example/on.safetensors',
  name: 'on.safetensors',
  hashes: [{ hash: 'on' }],
};

describe("getFileForModelVersion (the version's files)", () => {
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  beforeEach(() => {
    modelVersionFindFirst.mockReset().mockResolvedValue(publishedModelVersion());
    modelFileFindMany.mockReset().mockResolvedValue([offFile]);
    hasEntityAccessMock.mockReset().mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockReset().mockResolvedValue({});
    resolveDownloadUrlMock
      .mockReset()
      .mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });
    q.listDownloadFiles.mockReset();
    setFlag(false);
  });

  const viewer = { id: 1, isModerator: false };
  const resolvedFileIds = () => resolveDownloadUrlMock.mock.calls.map((call) => call[0]);

  it('OFF, by type: the Prisma read on the replica, with the same where', async () => {
    await getFileForModelVersion({ modelVersionId: 1, type: 'Model', noAuth: true, user: viewer });
    expect(modelFileFindMany.mock.calls[0][0].where).toEqual({
      modelVersionId: 1,
      replacedAt: null,
      type: 'Model',
      visibility: 'Public',
    });
    expect(resolvedFileIds()).toEqual([offFile.id]);
    expect(flag.mock.calls.filter(([key]) => key === FLAG)).toEqual([[FLAG]]);
    expect(q.listDownloadFiles).not.toHaveBeenCalled();
  });

  it('OFF, by id: the Prisma read on the replica, with the same where', async () => {
    await getFileForModelVersion({
      modelVersionId: 1,
      fileId: offFile.id,
      noAuth: true,
      user: viewer,
    });
    expect(modelFileFindMany.mock.calls[0][0].where).toEqual({
      modelVersionId: 1,
      visibility: 'Public',
    });
    expect(resolvedFileIds()).toEqual([offFile.id]);
  });

  it('ON, by type: the Kysely read on the replica, whose file is served', async () => {
    setFlag(true);
    q.listDownloadFiles.mockResolvedValue([onFile] as never);
    await getFileForModelVersion({ modelVersionId: 1, type: 'Model', noAuth: true, user: viewer });
    expect(q.listDownloadFiles.mock.calls).toEqual([
      [kyselyRead, { modelVersionId: 1, notReplaced: true, type: 'Model', publicOnly: true }],
    ]);
    expect(q.listDownloadFiles.mock.calls[0][0]).toBe(kyselyRead);
    expect(resolvedFileIds()).toEqual([onFile.id]);
    expect(modelFileFindMany).not.toHaveBeenCalled();
  });

  it('ON, by id, as a moderator: the Kysely read, every visibility', async () => {
    setFlag(true);
    q.listDownloadFiles.mockResolvedValue([onFile] as never);
    await getFileForModelVersion({
      modelVersionId: 1,
      fileId: onFile.id,
      noAuth: true,
      user: { id: 1, isModerator: true },
    });
    expect(q.listDownloadFiles.mock.calls).toEqual([
      [kyselyRead, { modelVersionId: 1, publicOnly: false }],
    ]);
    expect(resolvedFileIds()).toEqual([onFile.id]);
    expect(modelFileFindMany).not.toHaveBeenCalled();
  });
});
