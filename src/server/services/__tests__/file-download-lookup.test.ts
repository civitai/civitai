import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

// getFileForModelVersion sources the EA gate from getPaidAccess. Defaults to no gate so the lookup
// runs unblocked; the access-denial tests below drive an active gate through it.
const getPaidAccessMock = vi.fn();
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: getPaidAccessMock,
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

function unpublishedModelVersion(overrides: Record<string, unknown> = {}) {
  const base = publishedModelVersion();
  return {
    ...base,
    status: 'Unpublished',
    model: { ...base.model, status: 'Unpublished', publishedAt: null },
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

describe('getFileForModelVersion — orphan model relation + unresolvable URL', () => {
  // The first dynamic import cold-transforms a large module graph. On a loaded CI
  // box that transform can exceed a per-test timeout (a 30s describe override
  // flaked here under contention). Pay it ONCE in beforeAll with a generous hook
  // timeout, then every test uses the warm reference — no per-test import race.
  let getFileForModelVersion: typeof import('../file.service')['getFileForModelVersion'];
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  beforeEach(() => {
    modelVersionFindFirst.mockReset();
    modelFileFindMany.mockReset();
    modelFileFindFirst.mockReset();
    recommendedResourceFindFirst.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();
    getPaidAccessMock.mockReset();

    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockResolvedValue({});
    modelFileFindMany.mockResolvedValue([aFile]);
  });

  // --- Fix #4: orphaned ModelVersion.model -------------------------------
  it('passes a `model: { is: {} }` existence filter so orphaned-model versions are dropped at the DB', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });
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
    const result = await getFileForModelVersion({ modelVersionId: 1, noAuth: true });

    expect(result.status).toBe('not-found');
  });

  // --- Fix #3: genuinely-unresolvable delivery URL -----------------------
  it('returns resolve-failed (→404 no-store), NOT error (→500), when the delivery URL cannot be resolved', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    // Both storage-resolver and delivery-worker rejected → resolveDownloadUrl throws.
    resolveDownloadUrlMock.mockRejectedValue(new Error('Delivery worker error: Not Found'));
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
    const result = await getFileForModelVersion({
      modelVersionId: 1,
      noAuth: true,
      user: { id: 1, isModerator: true },
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.url).toBe('https://cdn.example.com/signed');
  });

  // --- Access denial must not masquerade as "you need to log in" ----------
  // A signed-in user who lacks a grant used to get `unauthorized`, which the download endpoint
  // answers with a redirect to /login. Already having a session, they were bounced straight back to
  // the page they came from — the download button appeared to do nothing at all.
  it('returns no-access (→403), NOT unauthorized (→/login), for a signed-in user without a grant', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: false, permissions: -1 }]);

    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1234, isModerator: false },
    });

    expect(result.status).toBe('no-access');
    expect(result.status).not.toBe('unauthorized');
  });

  it('still returns unauthorized (→/login) when there is no session at all', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: false, permissions: -1 }]);

    const result = await getFileForModelVersion({ modelVersionId: 1 });

    // No session → a login redirect is the correct answer; the split must not swallow it.
    expect(result.status).toBe('unauthorized');
  });

  it('routes an active paid gate to early-access (→purchase) rather than a bare denial', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    getPaidAccessMock.mockResolvedValue({ 1: { endsAt, terms: { download: { price: 100 } } } });
    // Has an access record, but not the EarlyAccessDownload bit (e.g. paid for generation only).
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);

    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1234, isModerator: false },
    });

    expect(result.status).toBe('early-access');
    if (result.status === 'early-access') expect(result.details.deadline).toEqual(endsAt);
  });

  // The common case, and the one the bit-test read backwards: a user who has bought nothing carries
  // the "no grant" sentinel `permissions: -1` (every bit set), so `permissions & EarlyAccessDownload`
  // is non-zero and reads as "already holds the download grant". The purchase route was skipped and
  // the user got a dead-end 403 instead of the buy CTA.
  it('routes a user with no grant at all to early-access, not a bare denial', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    getPaidAccessMock.mockResolvedValue({ 1: { endsAt, terms: { download: { price: 100 } } } });
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: false, permissions: -1 }]);

    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1234, isModerator: false },
    });

    expect(result.status).toBe('early-access');
  });

  it('lets an actual early-access buyer through the gate', async () => {
    modelVersionFindFirst.mockResolvedValue(publishedModelVersion());
    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    getPaidAccessMock.mockResolvedValue({ 1: { endsAt, terms: { download: { price: 100 } } } });
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 2 }]);
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });

    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1234, isModerator: false },
    });

    expect(result.status).toBe('success');
  });

  // --- Unpublished models: the review path ---------------------------------
  // Moderators review unpublished models constantly (takedowns, TOS checks) and need the actual
  // file to decide. The publish-state gate must keep answering them — and the owner — with the
  // file while still hiding it from everyone else.
  describe('unpublished models', () => {
    beforeEach(() => {
      modelVersionFindFirst.mockResolvedValue(unpublishedModelVersion());
      resolveDownloadUrlMock.mockResolvedValue({
        url: 'https://cdn.example.com/signed',
        urlExpiryDate: new Date(),
      });
    });

    it('serves the file to a moderator', async () => {
      const result = await getFileForModelVersion({
        modelVersionId: 1,
        user: { id: 7, isModerator: true },
      });

      expect(result.status).toBe('success');
    });

    it('serves the file to the owner', async () => {
      const result = await getFileForModelVersion({
        modelVersionId: 1,
        user: { id: 999, isModerator: false },
      });

      expect(result.status).toBe('success');
    });

    it('returns not-found for a signed-in user who is neither owner nor moderator', async () => {
      const result = await getFileForModelVersion({
        modelVersionId: 1,
        user: { id: 1234, isModerator: false },
      });

      expect(result.status).toBe('not-found');
    });

    it('returns not-found for an anonymous request', async () => {
      const result = await getFileForModelVersion({ modelVersionId: 1 });

      expect(result.status).toBe('not-found');
    });

    it('still hides a deleted model from its own owner', async () => {
      modelVersionFindFirst.mockResolvedValue(
        unpublishedModelVersion({
          model: { ...publishedModelVersion().model, status: 'Deleted' },
        })
      );

      const result = await getFileForModelVersion({
        modelVersionId: 1,
        user: { id: 999, isModerator: false },
      });

      expect(result.status).toBe('not-found');
    });
  });
});

/**
 * THE SEAM: a serialized `downloadUrl` is a CLAIM that the download route will
 * resolve it. Nothing tested that claim — the endpoint suites assert URL
 * strings, and this file's other cases never touch `fileId` or the
 * linked-component fallback. So a URL pairing a spliced VAE file's id with the
 * HOST version passed every assertion in the repo and 404s in production.
 *
 * These cases build the URL with the REAL helper the endpoints use, parse it the
 * way `/api/download/models/[modelVersionId]` does, and feed it to the REAL
 * `getFileForModelVersion` over a Prisma stub that enforces the actual `where`
 * clauses. `not-found` here IS the production 404.
 */
describe('serialized downloadUrl → getFileForModelVersion (the pair actually resolves)', () => {
  let getFileForModelVersion: typeof import('../file.service')['getFileForModelVersion'];
  let createSerializedFileDownloadUrl: typeof import('~/server/common/model-helpers')['createSerializedFileDownloadUrl'];
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
    ({ createSerializedFileDownloadUrl } = await import('~/server/common/model-helpers'));
  }, 60000);

  const HOST_VERSION_ID = 4242;
  const LINKED_VAE_VERSION_ID = 9999;
  const PUBLIC_REQUESTER = { id: 1234, isModerator: false };

  // The whole file universe, with the version each file REALLY belongs to.
  const OWNED_PRIMARY = {
    id: 21,
    modelVersionId: HOST_VERSION_ID,
    url: 'https://r2/host-primary.safetensors',
    name: 'host-primary.safetensors',
    overrideName: null,
    type: 'Model',
    visibility: 'Public',
    metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
    hashes: [{ hash: 'aaaa1111' }],
  };
  const OWNED_SECOND = {
    id: 22,
    modelVersionId: HOST_VERSION_ID,
    url: 'https://r2/host-second.ckpt',
    name: 'host-second.ckpt',
    overrideName: null,
    type: 'Model',
    visibility: 'Public',
    metadata: { format: 'PickleTensor', size: 'full', fp: 'fp32' },
    hashes: [{ hash: 'bbbb2222' }],
  };
  // Lives on the LINKED version. `getVaeFiles` relabels its `type` to 'VAE'
  // when splicing it into the host response; in the DB it is still 'Model'.
  const LINKED_VAE = {
    id: 91,
    modelVersionId: LINKED_VAE_VERSION_ID,
    url: 'https://r2/linked-vae.safetensors',
    name: 'linked-vae.safetensors',
    overrideName: null,
    type: 'Model',
    visibility: 'Public',
    metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' },
    hashes: [{ hash: 'eeee5555' }],
  };
  const UNIVERSE = [OWNED_PRIMARY, OWNED_SECOND, LINKED_VAE];

  const matches = (f: (typeof UNIVERSE)[number], where: Record<string, unknown>) =>
    (where.id === undefined || f.id === where.id) &&
    (where.modelVersionId === undefined || f.modelVersionId === where.modelVersionId) &&
    (where.type === undefined || f.type === where.type) &&
    (where.visibility === undefined || f.visibility === where.visibility);

  beforeEach(() => {
    modelVersionFindFirst.mockReset();
    modelFileFindMany.mockReset();
    modelFileFindFirst.mockReset();
    recommendedResourceFindFirst.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();
    getPaidAccessMock.mockReset();

    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockResolvedValue({});
    modelVersionFindFirst.mockImplementation(async () =>
      publishedModelVersion({ id: HOST_VERSION_ID })
    );
    resolveDownloadUrlMock.mockImplementation(async (_id: number, url: string) => ({
      url,
      urlExpiryDate: new Date(),
    }));

    // Prisma stubs that ENFORCE the where clause — this is what makes a
    // mismatched (versionId, fileId) pair come back empty, exactly as in prod.
    modelFileFindFirst.mockImplementation(async ({ where }: any) => {
      const found = UNIVERSE.filter((f) => matches(f, where)).sort((a, b) => a.id - b.id);
      return found[0] ?? null;
    });
    modelFileFindMany.mockImplementation(async ({ where }: any) =>
      UNIVERSE.filter((f) => matches(f, where))
    );
    // The host version links the VAE version as a component.
    recommendedResourceFindFirst.mockImplementation(async ({ where }: any) =>
      where.sourceId === HOST_VERSION_ID
        ? {
            resourceId: LINKED_VAE_VERSION_ID,
            settings: { isLinkedComponent: true, componentType: 'VAE' },
          }
        : null
    );
  });

  /** Parse an emitted URL into the route's handler input (schema at
   * src/pages/api/download/models/[modelVersionId].ts). */
  function toRouteInput(path: string) {
    const url = new URL(`https://civitai.com${path}`);
    const modelVersionId = Number(url.pathname.split('/').pop());
    const q = url.searchParams;
    const fileIdParam = q.get('fileId');
    return {
      modelVersionId,
      fileId: fileIdParam ? Number(fileIdParam) : undefined,
      type: q.get('type') ?? undefined,
      format: q.get('format') ?? undefined,
      size: q.get('size') ?? undefined,
      fp: q.get('fp') ?? undefined,
      quantType: q.get('quantType') ?? undefined,
    } as never;
  }

  it('a pinned URL for a file the version OWNS resolves to exactly that file', async () => {
    const path = createSerializedFileDownloadUrl({
      file: OWNED_SECOND,
      hostVersionId: HOST_VERSION_ID,
    });
    // Positive control: this URL really is the pinned shape.
    expect(path).toBe('/api/download/models/4242?fileId=22');

    const result = (await getFileForModelVersion({
      ...toRouteInput(path),
      noAuth: true,
      // A plain signed-in, non-owner, non-mod requester: `requireAuth` is
      // satisfied (UNAUTHENTICATED_DOWNLOAD is off in the test env) while the
      // Public visibility filter still applies, i.e. the public download path.
      user: PUBLIC_REQUESTER,
    })) as { status: string; fileId?: number; url?: string };
    expect(result.status).toBe('success');
    expect(result.fileId).toBe(22);
    expect(result.url).toBe(OWNED_SECOND.url);
  });

  it('the URL emitted for a SPLICED VAE file resolves (it is not pinned to the host version)', async () => {
    const path = createSerializedFileDownloadUrl({
      // `type: 'VAE'` is the relabel getVaeFiles applies.
      file: { ...LINKED_VAE, type: 'VAE' },
      hostVersionId: HOST_VERSION_ID,
    });
    expect(new URL(`https://x.test${path}`).searchParams.get('fileId')).toBeNull();

    const result = (await getFileForModelVersion({
      ...toRouteInput(path),
      noAuth: true,
      // A plain signed-in, non-owner, non-mod requester: `requireAuth` is
      // satisfied (UNAUTHENTICATED_DOWNLOAD is off in the test env) while the
      // Public visibility filter still applies, i.e. the public download path.
      user: PUBLIC_REQUESTER,
    })) as { status: string; fileId?: number };
    // Resolved through the linked-component fallback, to the VAE file itself.
    expect(result.status).toBe('success');
    expect(result.fileId).toBe(91);
  });

  it('NEGATIVE CONTROL: the pair the bug emitted (fileId=91 on version 4242) is a 404', async () => {
    // Built by hand, NOT by the helper — this is the URL the unguarded pin
    // produced, and it must be observably not-found, or the two tests above
    // prove nothing about the seam.
    const result = (await getFileForModelVersion({
      ...toRouteInput('/api/download/models/4242?fileId=91'),
      noAuth: true,
      // A plain signed-in, non-owner, non-mod requester: `requireAuth` is
      // satisfied (UNAUTHENTICATED_DOWNLOAD is off in the test env) while the
      // Public visibility filter still applies, i.e. the public download path.
      user: PUBLIC_REQUESTER,
    })) as { status: string };
    expect(result.status).toBe('not-found');
  });

  it('a pinned URL respects the version boundary in the DB query itself', async () => {
    await getFileForModelVersion({
      ...toRouteInput('/api/download/models/4242?fileId=21'),
      noAuth: true,
      user: PUBLIC_REQUESTER,
    });
    const where = modelFileFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 21, modelVersionId: 4242 });
  });
});
