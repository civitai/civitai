import { beforeEach, describe, expect, it, vi } from 'vitest';

// file.service.ts imports `@prisma/client` (type-only) plus a wide graph that
// calls Prisma runtime helpers at module load. Mirror the house stub pattern
// (see prisma-inconsistent-orphan-relations.test) so the externalised
// @prisma/client doesn't blow up at SSR import time.
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

const modelVersionFindFirst = vi.fn();
const modelFileFindMany = vi.fn();
const modelFileFindFirst = vi.fn();
const recommendedResourceFindFirst = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    modelVersion: { findFirst: modelVersionFindFirst },
    modelFile: { findMany: modelFileFindMany, findFirst: modelFileFindFirst },
    recommendedResource: { findFirst: recommendedResourceFindFirst },
  },
  dbWrite: {},
}));

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

// Control whether the delivery URL resolves. A throw here is the
// "genuinely unresolvable URL" case the fix must turn into a 404 (`not-found`),
// NOT a 500 (`error`).
const resolveDownloadUrlMock = vi.fn();
vi.mock('~/utils/delivery-worker', () => ({
  resolveDownloadUrl: resolveDownloadUrlMock,
}));

// The global setup mocks logToAxiom but not safeError (used in the resolve
// catch). Provide both so the unresolvable-URL path logs without throwing.
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
  safeError: (err: unknown) => ({ name: 'Error', message: String(err) }),
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

const aFile = {
  id: 55,
  url: 'https://abcd1234.r2.cloudflarestorage.com/civitai/files/x.safetensors',
  name: 'x.safetensors',
  overrideName: null,
  type: 'Model',
  metadata: { format: 'SafeTensor' },
  hashes: [{ hash: 'abc' }],
};

// timeout: the first dynamic import cold-transforms a large module graph.
describe('getFileForModelVersion — orphan model relation + unresolvable URL', { timeout: 30000 }, () => {
  beforeEach(() => {
    modelVersionFindFirst.mockReset();
    modelFileFindMany.mockReset();
    modelFileFindFirst.mockReset();
    recommendedResourceFindFirst.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();

    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    modelFileFindMany.mockResolvedValue([aFile]);
  });

  // --- Fix #4: orphaned ModelVersion.model -------------------------------
  it('passes a `model: { is: {} }` existence filter so orphaned-model versions are dropped at the DB', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });

    const { getFileForModelVersion } = await import('../file.service');
    await getFileForModelVersion({ modelVersionId: 1, noAuth: true });

    expect(modelVersionFindFirst).toHaveBeenCalledTimes(1);
    const args = modelVersionFindFirst.mock.calls[0][0];
    // The load-bearing fix: without `model: { is: {} }`, a version whose `model`
    // FK points at a deleted Model makes Prisma throw "Inconsistent query result:
    // Field model is required to return data, got null" → 500.
    expect(args.where.model).toEqual({ is: {} });
  });

  it('returns not-found (→404) when the orphan filter drops the row (findFirst → null)', async () => {
    // Post-fix DB behaviour: an orphan-model version is filtered out, so findFirst
    // returns null instead of throwing. The handler maps that to `not-found`.
    modelVersionFindFirst.mockResolvedValue(null);

    const { getFileForModelVersion } = await import('../file.service');
    const result = await getFileForModelVersion({ modelVersionId: 1, noAuth: true });

    expect(result.status).toBe('not-found');
  });

  // --- Fix #3: genuinely-unresolvable delivery URL -----------------------
  it('returns resolve-failed (→404 no-store), NOT error (→500), when the delivery URL cannot be resolved', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    // Both storage-resolver and delivery-worker rejected → resolveDownloadUrl throws.
    resolveDownloadUrlMock.mockRejectedValue(new Error('Delivery worker error: Not Found'));

    const { getFileForModelVersion } = await import('../file.service');
    // Authenticated owner-or-mod so the request passes the auth gate and reaches
    // URL resolution (where the unresolvable-URL → resolve-failed routing lives).
    const result = await getFileForModelVersion({
      modelVersionId: 1,
      noAuth: true,
      user: { id: 1, isModerator: true },
    });

    // A broken/missing delivery URL is not a server fault (still 404 at the
    // endpoint), but it gets a DISTINCT status from the deterministic by-id
    // not-found so the endpoint can mark it `Cache-Control: no-store` — a
    // resolve failure can be TRANSIENT (storage outage) and must not be
    // edge-cached for 5 min.
    expect(result.status).toBe('resolve-failed');
    expect(result.status).not.toBe('error');
    // Distinct from the deterministic not-found (which stays CDN-cacheable).
    expect(result.status).not.toBe('not-found');
  });

  it('returns success with the resolved url on the happy path', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({
      url: 'https://cdn.example.com/signed',
      urlExpiryDate: new Date(),
    });

    const { getFileForModelVersion } = await import('../file.service');
    const result = await getFileForModelVersion({
      modelVersionId: 1,
      noAuth: true,
      user: { id: 1, isModerator: true },
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.url).toBe('https://cdn.example.com/signed');
  });
});
