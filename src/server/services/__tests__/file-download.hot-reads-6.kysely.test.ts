import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FileService from '../file.service';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as HotReads5Reads from '~/server/services/hot-reads-5.reads';
import * as queries from '@civitai/db-queries/hot-reads-6';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

/**
 * The download path's file list (`getFileForModelVersion`), on its two paths (by file id, and by
 * type): the Kysely read on the replica, with the filters the Prisma `where` had, whose file is the
 * one resolved (the Prisma stub holds a different one). The module setup below is
 * file-download-lookup.test.ts's.
 */

// Any flag read on these paths answers false, without a Flipt client.
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

// The version and its model, in the Prisma shape the Kysely reader returns; its rows are pinned in
// hot-reads-5.kysely-parity.test.ts.
const { versionRead } = vi.hoisted(() => ({ versionRead: vi.fn() }));
vi.mock('~/server/services/hot-reads-5.reads', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5Reads>()),
  readModelVersionForFileViaKysely: versionRead,
}));
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

/** What the Prisma file stub holds, so a file served from it is told apart from the Kysely one. */
const prismaFile = {
  id: 9455,
  url: 'https://files.example/prisma.safetensors',
  name: 'prisma.safetensors',
  overrideName: null,
  type: 'Model',
  metadata: { format: 'SafeTensor' },
  sizeKB: 10,
  hashes: [{ hash: 'prisma' }],
};
const kyselyFile = {
  ...prismaFile,
  id: 9456,
  url: 'https://files.example/kysely.safetensors',
  name: 'kysely.safetensors',
  hashes: [{ hash: 'kysely' }],
};

describe("getFileForModelVersion (the version's files)", () => {
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  beforeEach(() => {
    versionRead.mockReset().mockResolvedValue(publishedModelVersion());
    modelFileFindMany.mockReset().mockResolvedValue([prismaFile]);
    hasEntityAccessMock.mockReset().mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockReset().mockResolvedValue({});
    resolveDownloadUrlMock
      .mockReset()
      .mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });
    q.listDownloadFiles.mockReset();
    flag.mockReset().mockResolvedValue(false);
  });

  const viewer = { id: 1, isModerator: false };
  const resolvedFileIds = () => resolveDownloadUrlMock.mock.calls.map((call) => call[0]);

  it('by type: the Kysely read on the replica, whose file is served', async () => {
    q.listDownloadFiles.mockResolvedValue([kyselyFile] as never);
    await getFileForModelVersion({ modelVersionId: 1, type: 'Model', noAuth: true, user: viewer });
    expect(q.listDownloadFiles.mock.calls).toEqual([
      [kyselyRead, { modelVersionId: 1, notReplaced: true, type: 'Model', publicOnly: true }],
      [kyselyRead, { modelVersionId: 1 }],
    ]);
    expect(q.listDownloadFiles.mock.calls[0][0]).toBe(kyselyRead);
    expect(resolvedFileIds()).toEqual([kyselyFile.id]);
    expect(modelFileFindMany).not.toHaveBeenCalled();
  });

  it('by id: the Kysely read on the replica, public files only', async () => {
    q.listDownloadFiles.mockResolvedValue([kyselyFile] as never);
    await getFileForModelVersion({
      modelVersionId: 1,
      fileId: kyselyFile.id,
      noAuth: true,
      user: viewer,
    });
    // The second read is every file on the version, which the download is named against.
    expect(q.listDownloadFiles.mock.calls).toEqual([
      [kyselyRead, { modelVersionId: 1, publicOnly: true }],
      [kyselyRead, { modelVersionId: 1 }],
    ]);
    expect(q.listDownloadFiles.mock.calls[0][0]).toBe(kyselyRead);
    expect(resolvedFileIds()).toEqual([kyselyFile.id]);
    expect(modelFileFindMany).not.toHaveBeenCalled();
  });

  it('by id, as a moderator: the Kysely read, every visibility', async () => {
    q.listDownloadFiles.mockResolvedValue([kyselyFile] as never);
    await getFileForModelVersion({
      modelVersionId: 1,
      fileId: kyselyFile.id,
      noAuth: true,
      user: { id: 1, isModerator: true },
    });
    expect(q.listDownloadFiles.mock.calls).toEqual([
      [kyselyRead, { modelVersionId: 1, publicOnly: false }],
    ]);
    expect(resolvedFileIds()).toEqual([kyselyFile.id]);
    expect(modelFileFindMany).not.toHaveBeenCalled();
  });
});
