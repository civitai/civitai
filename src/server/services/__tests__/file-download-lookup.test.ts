import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
// Type-only: erased at runtime, so the dynamic-import warm-up in each describe
// (which is what keeps the heavy module graph off the per-test timeout) still
// does the actual loading. Replaces inline `typeof import(...)` annotations,
// which this repo's eslint config forbids.
import type * as FileService from '../file.service';
import type * as ModelHelpers from '~/server/common/model-helpers';
import type * as TrainingDataRestricted from '~/server/services/training-data-restricted.service';
import type * as HotReads5Reads from '~/server/services/hot-reads-5.reads';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type { ModelType } from '~/shared/utils/prisma/enums';

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

// The version and its model, in the Prisma shape the Kysely reader returns (`null` for no row).
// Its rows, against a real database, are pinned in hot-reads-5.kysely-parity.test.ts.
const { versionRead } = vi.hoisted(() => ({ versionRead: vi.fn() }));
vi.mock('~/server/services/hot-reads-5.reads', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5Reads>()),
  readModelVersionForFileViaKysely: versionRead,
}));

// The version's files are read through Kysely (`listDownloadFiles`, which takes the client and the
// filters the Prisma `where` was built from); its rows are pinned against a real database in
// hot-reads-6.kysely-parity.test.ts.
const { listDownloadFilesMock } = vi.hoisted(() => ({ listDownloadFilesMock: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  listDownloadFiles: listDownloadFilesMock,
}));
/** The filters of the `n`th files read. */
const filesFilter = (n = 0) => listDownloadFilesMock.mock.calls[n][1];

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

// Restricted owner or content, for a shared training dataset. Unrestricted unless a test says so.
const { shareRestrictedMock } = vi.hoisted(() => ({ shareRestrictedMock: vi.fn() }));
vi.mock('~/server/services/training-data-restricted.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TrainingDataRestricted>()),
  trainingDataShareRestricted: shareRestrictedMock,
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
    baseModel: 'SD 1.5',
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
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  beforeEach(() => {
    versionRead.mockReset();
    listDownloadFilesMock.mockReset();
    modelFileFindFirst.mockReset();
    recommendedResourceFindFirst.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();
    getPaidAccessMock.mockReset();

    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockResolvedValue({});
    listDownloadFilesMock.mockResolvedValue([aFile]);
  });

  // --- Fix #4: orphaned ModelVersion.model -------------------------------
  // The version read's inner join drops a version whose model row was hard-deleted (an orphaned
  // foreign key); that join, against a real database, is pinned in hot-reads-5.kysely-parity.test.ts.
  it('reads the version once, by its id, through Kysely on the replica', async () => {
    const { kyselyRead } = await import('~/server/db/kyselyDb');
    versionRead.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });
    await getFileForModelVersion({ modelVersionId: 1, noAuth: true });

    expect(versionRead.mock.calls).toEqual([[kyselyRead, 1]]);
    expect(versionRead.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.modelVersion.findFirst).not.toHaveBeenCalled();
  });

  it('returns not-found (→404) when the version read finds no row, as for an orphan', async () => {
    // An orphan-model version comes back as no row, not a throw. The handler maps that to
    // `not-found`.
    versionRead.mockResolvedValue(null);
    const result = await getFileForModelVersion({ modelVersionId: 1, noAuth: true });

    expect(result.status).toBe('not-found');
  });

  // --- Fix #3: genuinely-unresolvable delivery URL -----------------------
  it('returns resolve-failed (→404 no-store), NOT error (→500), when the delivery URL cannot be resolved', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
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
    versionRead.mockResolvedValue(publishedModelVersion());
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

  it('never picks a replaced file when resolving the primary file', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });

    await getFileForModelVersion({
      modelVersionId: 1,
      noAuth: true,
      user: { id: 1, isModerator: true },
    });

    expect(filesFilter()).toMatchObject({ notReplaced: true });
  });

  it('never picks a replaced file when resolving by type', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });

    await getFileForModelVersion({
      modelVersionId: 1,
      type: 'VAE',
      noAuth: true,
      user: { id: 1, isModerator: true },
    });

    expect(filesFilter()).toMatchObject({ notReplaced: true });
  });

  it('still serves a replaced file asked for by its id', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });

    await getFileForModelVersion({
      modelVersionId: 1,
      fileId: aFile.id,
      noAuth: true,
      user: { id: 1, isModerator: true },
    });

    expect(filesFilter().notReplaced).toBeUndefined();
  });

  // --- Access denial must not masquerade as "you need to log in" ----------
  // A signed-in user who lacks a grant used to get `unauthorized`, which the download endpoint
  // answers with a redirect to /login. Already having a session, they were bounced straight back to
  // the page they came from — the download button appeared to do nothing at all.
  it('returns no-access (→403), NOT unauthorized (→/login), for a signed-in user without a grant', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: false, permissions: -1 }]);

    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1234, isModerator: false },
    });

    expect(result.status).toBe('no-access');
    expect(result.status).not.toBe('unauthorized');
  });

  it('still returns unauthorized (→/login) when there is no session at all', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: false, permissions: -1 }]);

    const result = await getFileForModelVersion({ modelVersionId: 1 });

    // No session → a login redirect is the correct answer; the split must not swallow it.
    expect(result.status).toBe('unauthorized');
  });

  it('routes an active paid gate to early-access (→purchase) rather than a bare denial', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    getPaidAccessMock.mockResolvedValue({ 1: { endsAt, terms: { download: { price: 100 } } } });
    // Has an access record, but not the EarlyAccessDownload bit (e.g. paid for generation only).
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);

    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1234, isModerator: false },
    });

    expect(result.status).toBe('early-access');
    if (result.status === 'early-access')
      expect(result.details).toEqual({ deadline: endsAt, baseModel: 'SD 1.5' });
  });

  // The common case, and the one the bit-test read backwards: a user who has bought nothing carries
  // the "no grant" sentinel `permissions: -1` (every bit set), so `permissions & EarlyAccessDownload`
  // is non-zero and reads as "already holds the download grant". The purchase route was skipped and
  // the user got a dead-end 403 instead of the buy CTA.
  it('routes a user with no grant at all to early-access, not a bare denial', async () => {
    versionRead.mockResolvedValue(publishedModelVersion());
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
    versionRead.mockResolvedValue(publishedModelVersion());
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
      versionRead.mockResolvedValue(unpublishedModelVersion());
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
      versionRead.mockResolvedValue(
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

  // A taken-down model's files are served to moderators only, with the same answer as a deleted one.
  describe('taken-down models', () => {
    const OWNER = { id: 999, isModerator: false };
    const takenDown = () =>
      publishedModelVersion({ model: { ...publishedModelVersion().model, mode: 'TakenDown' } });
    const download = (user?: { id: number; isModerator: boolean }) =>
      getFileForModelVersion({ modelVersionId: 1, user } as never);

    beforeEach(() => {
      // Anonymous downloads on, so an anonymous caller reaches the file rather than the login gate.
      setEnv({ UNAUTHENTICATED_DOWNLOAD: true });
      resolveDownloadUrlMock.mockResolvedValue({
        url: 'https://cdn.example.com/signed',
        urlExpiryDate: new Date(),
      });
    });
    afterEach(() => resetEnv());

    it.each([
      ['its owner', OWNER],
      ['an anonymous request', undefined],
      ['a signed-in non-owner', { id: 4321, isModerator: false }],
    ])('is not-found for %s, exactly as a deleted model is', async (_who, user) => {
      versionRead.mockResolvedValue(
        publishedModelVersion({ model: { ...publishedModelVersion().model, status: 'Deleted' } })
      );
      const deleted = await download(user);
      versionRead.mockResolvedValue(takenDown());

      const result = await download(user);

      expect(result).toEqual({ status: 'not-found' });
      expect(result).toEqual(deleted);
      expect(resolveDownloadUrlMock).not.toHaveBeenCalled();
    });

    it('is still served to a moderator', async () => {
      versionRead.mockResolvedValue(takenDown());

      expect((await download({ id: 7, isModerator: true })).status).toBe('success');
    });

    it.each([
      ['its owner', OWNER],
      ['an anonymous request', undefined],
      ['a signed-in non-owner', { id: 4321, isModerator: false }],
    ])('leaves a model that is not taken down served to %s', async (_who, user) => {
      versionRead.mockResolvedValue(publishedModelVersion());

      expect((await download(user)).status).toBe('success');
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
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  let createSerializedFileDownloadUrl: typeof ModelHelpers.createSerializedFileDownloadUrl;
  type RouteInput = Omit<Parameters<typeof getFileForModelVersion>[0], 'user' | 'noAuth'>;
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
    metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' } as BasicFileMetadata,
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
    metadata: { format: 'PickleTensor', size: 'full', fp: 'fp32' } as BasicFileMetadata,
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
    metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' } as BasicFileMetadata,
    hashes: [{ hash: 'eeee5555' }],
  };
  const UNIVERSE = [OWNED_PRIMARY, OWNED_SECOND, LINKED_VAE];
  /** The model the linked VAE version belongs to. */
  let linkedModel: { status: string; mode: string | null } = { status: 'Published', mode: null };

  const matches = (f: (typeof UNIVERSE)[number], where: Record<string, unknown>) =>
    (where.id === undefined || f.id === where.id) &&
    (where.modelVersionId === undefined || f.modelVersionId === where.modelVersionId) &&
    (where.type === undefined || f.type === where.type) &&
    (where.visibility === undefined || f.visibility === where.visibility);

  beforeEach(() => {
    versionRead.mockReset();
    listDownloadFilesMock.mockReset();
    modelFileFindFirst.mockReset();
    recommendedResourceFindFirst.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();
    getPaidAccessMock.mockReset();

    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockResolvedValue({});
    versionRead.mockImplementation(async () => publishedModelVersion({ id: HOST_VERSION_ID }));
    resolveDownloadUrlMock.mockImplementation(async (_id: number, url: string) => ({
      url,
      urlExpiryDate: new Date(),
    }));

    // Stubs that ENFORCE the where clause — this is what makes a
    // mismatched (versionId, fileId) pair come back empty, exactly as in prod.
    linkedModel = { status: 'Published', mode: null };
    // The linked version's model state comes back only when the read selects it, as in prod.
    modelFileFindFirst.mockImplementation(async ({ where, select }: any) => {
      const found = UNIVERSE.filter((f) => matches(f, where)).sort((a, b) => a.id - b.id);
      if (!found[0]) return null;
      return select?.modelVersion?.select?.model?.select?.mode
        ? { ...found[0], modelVersion: { status: 'Published', model: linkedModel } }
        : found[0];
    });
    // The Kysely files read enforces the same filters, given as the inputs the Prisma `where` was
    // built from.
    listDownloadFilesMock.mockImplementation(
      async (
        _db: unknown,
        filter: { modelVersionId: number; type?: string; publicOnly?: boolean }
      ) =>
        UNIVERSE.filter((f) =>
          matches(f, {
            modelVersionId: filter.modelVersionId,
            type: filter.type,
            visibility: filter.publicOnly ? 'Public' : undefined,
          })
        )
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
  function toRouteInput(path: string): RouteInput {
    const url = new URL(`https://civitai.com${path}`);
    const modelVersionId = Number(url.pathname.split('/').pop());
    const q = url.searchParams;
    const fileIdParam = q.get('fileId');
    // The enum-shaped params are cast one by one rather than the whole object being
    // widened: the route's zod schema is what narrows them in production, and a cast
    // per field still fails here if the service stops accepting one.
    return {
      modelVersionId,
      fileId: fileIdParam ? Number(fileIdParam) : undefined,
      type: (q.get('type') ?? undefined) as RouteInput['type'],
      format: (q.get('format') ?? undefined) as RouteInput['format'],
      size: (q.get('size') ?? undefined) as RouteInput['size'],
      fp: q.get('fp') ?? undefined,
      quantType: q.get('quantType') ?? undefined,
    };
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

  it.each([
    ['taken-down', { status: 'Published', mode: 'TakenDown' }],
    ['deleted', { status: 'Deleted', mode: null }],
  ])(
    'the linked fallback serves no file from a %s model, except to a moderator',
    async (_s, model) => {
      linkedModel = model;
      const vae = { modelVersionId: HOST_VERSION_ID, type: 'VAE' } as const;

      const refused = await getFileForModelVersion({ ...vae, user: PUBLIC_REQUESTER } as never);
      const forMod = (await getFileForModelVersion({
        ...vae,
        user: { id: 7, isModerator: true },
      } as never)) as { status: string; fileId?: number };

      expect(refused).toEqual({ status: 'not-found' });
      expect(forMod.status).toBe('success');
      expect(forMod.fileId).toBe(91);
    }
  );

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
    // The pin is applied in memory so the file's siblings come back too (they decide whether its
    // download name needs a variant suffix), which leaves the version — the boundary that matters —
    // as the only thing keeping another version's file out of the result set.
    expect(filesFilter()).toMatchObject({ modelVersionId: 4242 });
  });

  it('a pinned URL serves the file that was pinned, not the first on the version', async () => {
    // Guards the in-memory half of the pin above: version 4242 holds files 21 and 22, and 21 is
    // both lower-numbered and the primary, so picking wrongly still returns a plausible file.
    const result = (await getFileForModelVersion({
      ...toRouteInput('/api/download/models/4242?fileId=22'),
      noAuth: true,
      user: PUBLIC_REQUESTER,
    })) as { status: string; fileId?: number };

    expect(result.status).toBe('success');
    expect(result.fileId).toBe(22);
  });
});

/**
 * The SEAM between `getFileForModelVersion` and `resolveDownloadUrl`.
 *
 * 🔴 Measured before these existed: hardcoding `{ direct: true }` at the
 * `resolveDownloadUrl` call site, and dropping the 4th argument entirely, BOTH
 * passed the full download-path suite. The caller's `direct` had no observable
 * consequence anywhere in the tests — the option was threaded through code that
 * nothing asserted on.
 *
 * `direct` decides whether a download is served from a CDN or from the storage
 * origin, and those are billed differently. An always-on mutant is therefore a
 * silent cost regression, which is precisely the shape a test suite should not
 * be blind to.
 */
describe('getFileForModelVersion — the direct flag reaches resolveDownloadUrl', () => {
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  beforeEach(() => {
    versionRead.mockReset();
    listDownloadFilesMock.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();
    getPaidAccessMock.mockReset();

    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockResolvedValue({});
    listDownloadFilesMock.mockResolvedValue([aFile]);
    versionRead.mockResolvedValue(publishedModelVersion());
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });
  });

  // `requireAuth` defaults on when UNAUTHENTICATED_DOWNLOAD is unset, so a
  // user-less call returns `unauthorized` before it ever resolves a URL — which
  // would make every assertion below vacuous rather than failing.
  const A_USER = { id: 1, isModerator: true };
  const ATTRIBUTION = { caller: 'download-route', actor: 'user' } as const;

  // The 4th argument is the options bag. Asserting on it by index rather than
  // with objectContaining is deliberate: a dropped argument is `undefined`
  // there, and an objectContaining assertion cannot tell that from a present one.
  const optionsArg = () => resolveDownloadUrlMock.mock.calls[0][3];

  it.each([
    ['true', true],
    ['false', false],
  ])('forwards direct:%s exactly as given', async (_label, direct) => {
    await getFileForModelVersion({
      modelVersionId: 1,
      noAuth: true,
      user: A_USER,
      direct,
      attribution: ATTRIBUTION,
      redCapable: false,
    });

    expect(resolveDownloadUrlMock).toHaveBeenCalledTimes(1);
    expect(optionsArg()).toEqual({ direct, ...ATTRIBUTION });
  });

  // The caller's attribution reaches the resolver unchanged. Two distinct pairs
  // so a hardcoded caller or actor at the resolve cannot pass both.
  it.each([
    [{ caller: 'download-route', actor: 'anon' }],
    [{ caller: 'wildcard', actor: 'user' }],
  ] as const)('forwards attribution %o unchanged', async (attribution) => {
    await getFileForModelVersion({
      modelVersionId: 1,
      noAuth: true,
      user: A_USER,
      attribution,
      redCapable: false,
    });

    expect(optionsArg()).toStrictEqual({ direct: undefined, ...attribution });
  });

  // A caller that omits `direct` must not be upgraded to a direct resolve. This
  // is the default every pre-existing call site takes.
  it('passes direct:undefined when the caller omits it, never true', async () => {
    await getFileForModelVersion({
      modelVersionId: 1,
      noAuth: true,
      user: A_USER,
      attribution: ATTRIBUTION,
      redCapable: false,
    });

    // toStrictEqual, not toEqual: toEqual treats an undefined-valued key as equal
    // to a MISSING one, so it cannot tell `{ direct: undefined }` from `{}` — which
    // is exactly the distinction the comment above claims this assertion makes.
    expect(optionsArg()).toStrictEqual({ direct: undefined, ...ATTRIBUTION });
    expect(optionsArg()?.direct).not.toBe(true);
  });
});

// The API and search index advertise each file's name against every file on the version. The
// download route must name against the same set, not only the files the request could pick from,
// or two files that share an uploaded name download under one name and overwrite each other.
describe('getFileForModelVersion — names against every file on the version', () => {
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  let getDownloadFilename: typeof FileService.getDownloadFilename;
  beforeAll(async () => {
    ({ getFileForModelVersion, getDownloadFilename } = await import('../file.service'));
  }, 60000);

  const version = publishedModelVersion();
  const file = (id: number, type: string, visibility: string) => ({
    id,
    url: `https://abcd1234.r2.cloudflarestorage.com/civitai/files/${id}.safetensors`,
    name: 'shared.safetensors',
    overrideName: null as string | null,
    type,
    visibility,
    metadata: { format: 'SafeTensor' },
    hashes: [{ hash: `h${id}` }],
  });
  let versionFiles: ReturnType<typeof file>[] = [];

  beforeEach(() => {
    versionRead.mockReset();
    listDownloadFilesMock.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();
    getPaidAccessMock.mockReset();

    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockResolvedValue({});
    versionRead.mockResolvedValue(version);
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });
    // The Kysely files read, enforcing its filter the way the other describes here do.
    listDownloadFilesMock.mockImplementation(
      async (_db: unknown, filter: { type?: string; publicOnly?: boolean }) =>
        versionFiles.filter(
          (f) =>
            (filter.type === undefined || f.type === filter.type) &&
            (!filter.publicOnly || f.visibility === 'Public')
        )
    );
  });

  const ATTRIBUTION = { caller: 'download-route', actor: 'user' } as const;
  const servedName = () => resolveDownloadUrlMock.mock.calls[0][2];
  const advertisedName = (id: number) =>
    getDownloadFilename({
      model: { ...version.model, type: version.model.type as ModelType },
      modelVersion: version,
      file: versionFiles.find((f) => f.id === id)!,
      versionFiles,
    });

  it('serves each ?type= download under the name the API gives that file', async () => {
    versionFiles = [file(1, 'Model', 'Public'), file(2, 'VAE', 'Public')];
    expect(advertisedName(1)).not.toBe(advertisedName(2));

    for (const type of ['Model', 'VAE'] as const) {
      await getFileForModelVersion({
        modelVersionId: 1,
        type,
        user: { id: 1 },
        attribution: ATTRIBUTION,
        redCapable: false,
      });
    }

    expect(resolveDownloadUrlMock.mock.calls.map((call) => call[2])).toEqual([
      advertisedName(1),
      advertisedName(2),
    ]);
  });

  it.each([
    ['the primary file', {}],
    ['a pinned file id', { fileId: 1 }],
  ])('names %s against private siblings the viewer cannot see', async (_label, pick) => {
    versionFiles = [file(1, 'Model', 'Public'), file(2, 'Model', 'Private')];
    expect(advertisedName(1)).not.toBe('shared.safetensors');

    await getFileForModelVersion({
      modelVersionId: 1,
      ...pick,
      user: { id: 1 },
      attribution: ATTRIBUTION,
      redCapable: false,
    });

    expect(resolveDownloadUrlMock.mock.calls[0][0]).toBe(1);
    expect(servedName()).toBe(advertisedName(1));
  });

  // Stored names reach the delivery path as they are, so they are made header-safe on read.
  it('hands the delivery path a stored override name without an encoded line break', async () => {
    versionFiles = [{ ...file(1, 'Model', 'Public'), overrideName: 'old%0D%0Aname.safetensors' }];

    await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1 },
      attribution: ATTRIBUTION,
      redCapable: false,
    });

    expect(servedName()).toBe('old_0D_0Aname.safetensors');
    expect(advertisedName(1)).toBe('old_0D_0Aname.safetensors');
  });

  it('cleans the uploaded name a LoRA keeps, and leaves an ordinary one byte-identical', () => {
    const lora = { name: 'BB Bunny', type: 'LORA' as ModelType };
    const named = (name: string) => {
      const f = { ...file(1, 'Model', 'Public'), name };
      return getDownloadFilename({
        model: lora,
        modelVersion: version,
        file: f,
        versionFiles: [f],
      });
    };

    expect(named('bunny%0d%0a\u200e"x".safetensors')).toBe('bunny_0d_0a_x_.safetensors');
    expect(named('AshleyGraves_Krea2_byKonan (v2) 100%.safetensors')).toBe(
      'AshleyGraves_Krea2_byKonan (v2) 100%.safetensors'
    );
  });
});

describe('getFileForModelVersion — a file that failed its scan', () => {
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  beforeEach(() => {
    versionRead.mockReset();
    listDownloadFilesMock.mockReset();
    hasEntityAccessMock.mockReset();
    resolveDownloadUrlMock.mockReset();
    getPaidAccessMock.mockReset();

    versionRead.mockResolvedValue(publishedModelVersion());
    hasEntityAccessMock.mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockResolvedValue({});
    resolveDownloadUrlMock.mockResolvedValue({ url: 'https://cdn/ok', urlExpiryDate: new Date() });
  });

  const statusFor = async (
    scan: { pickleScanResult: string; virusScanResult: string },
    user: { id: number; isModerator?: boolean }
  ) => {
    listDownloadFilesMock.mockResolvedValue([{ ...aFile, ...scan }]);
    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user,
      attribution: { caller: 'download-route', actor: 'user' },
      redCapable: false,
    });
    return result.status;
  };

  const owner = { id: 999 };
  const member = { id: 5 };
  const moderator = { id: 6, isModerator: true };

  it('refuses a pickle or virus Danger file to members and the owner, not to moderators', async () => {
    for (const scan of [
      { pickleScanResult: 'Danger', virusScanResult: 'Success' },
      { pickleScanResult: 'Success', virusScanResult: 'Danger' },
    ]) {
      expect([
        await statusFor(scan, member),
        await statusFor(scan, owner),
        await statusFor(scan, moderator),
      ]).toEqual(['failed-scan', 'failed-scan', 'success']);
    }
  });

  it('serves a file whose scan errored or is still pending', async () => {
    expect([
      await statusFor({ pickleScanResult: 'Error', virusScanResult: 'Success' }, member),
      await statusFor({ pickleScanResult: 'Pending', virusScanResult: 'Pending' }, member),
    ]).toEqual(['success', 'success']);
  });
});

describe('getFileForModelVersion — a shared training dataset', () => {
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  const dataset = {
    ...aFile,
    id: 56,
    name: 'data.zip',
    type: 'Training Data',
    metadata: { nsfwLevel: 1 },
    virusScanResult: 'Success',
  };
  const download = (user: { id: number; isModerator?: boolean }) =>
    getFileForModelVersion({
      modelVersionId: 1,
      type: 'Training Data',
      user,
      attribution: { path: 'test', actor: 'test' } as never,
      redCapable: true,
    });

  beforeEach(() => {
    versionRead.mockReset().mockResolvedValue(publishedModelVersion());
    listDownloadFilesMock.mockReset().mockResolvedValue([dataset]);
    hasEntityAccessMock.mockReset().mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockReset().mockResolvedValue({});
    resolveDownloadUrlMock
      .mockReset()
      .mockResolvedValue({ url: 'https://cdn/data.zip', urlExpiryDate: new Date() });
    shareRestrictedMock.mockReset().mockResolvedValue(false);
  });

  it('is served to others while nothing is restricted', async () => {
    expect((await download({ id: 1 })).status).toBe('success');
  });

  it('is the same not-found as a missing file for others once its owner or content is restricted', async () => {
    shareRestrictedMock.mockResolvedValue(true);
    const result = await download({ id: 1 });
    expect(result).toEqual({ status: 'not-found' });
    expect(resolveDownloadUrlMock).not.toHaveBeenCalled();
  });

  it.each([
    ['its owner', { id: 999 }],
    ['a moderator', { id: 1, isModerator: true }],
  ])('is still served to %s while restricted', async (_, user) => {
    shareRestrictedMock.mockResolvedValue(true);
    expect((await download(user)).status).toBe('success');
  });

  it.each(['Pending', 'Error', null])(
    'is the same not-found as a missing file for others until its scan is a Success (%s)',
    async (virusScanResult) => {
      listDownloadFilesMock.mockResolvedValue([{ ...dataset, virusScanResult }]);
      const result = await download({ id: 1 });
      expect(result).toEqual({ status: 'not-found' });
      expect(resolveDownloadUrlMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['its owner', { id: 999 }],
    ['a moderator', { id: 1, isModerator: true }],
  ])('is served to %s before its scan completes', async (_, user) => {
    listDownloadFilesMock.mockResolvedValue([{ ...dataset, virusScanResult: 'Pending' }]);
    expect((await download(user)).status).toBe('success');
  });

  it('does not hold a model file to a completed scan', async () => {
    listDownloadFilesMock.mockResolvedValue([{ ...aFile, virusScanResult: 'Pending' }]);
    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1 },
      attribution: { path: 'test', actor: 'test' } as never,
      redCapable: true,
    });
    expect(result.status).toBe('success');
  });

  it('does not gate a model file', async () => {
    shareRestrictedMock.mockResolvedValue(true);
    listDownloadFilesMock.mockResolvedValue([aFile]);
    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1 },
      attribution: { path: 'test', actor: 'test' } as never,
      redCapable: true,
    });
    expect(result.status).toBe('success');
    expect(shareRestrictedMock).not.toHaveBeenCalled();
  });
});

describe('getFileForModelVersion — a training dataset on each host', () => {
  let getFileForModelVersion: typeof FileService.getFileForModelVersion;
  beforeAll(async () => {
    ({ getFileForModelVersion } = await import('../file.service'));
  }, 60000);

  const MATURE = 4 | 1; // R and PG items
  const datasetRated = (metadata: Record<string, unknown>) => ({
    ...aFile,
    id: 56,
    name: 'data.zip',
    type: 'Training Data',
    metadata,
    virusScanResult: 'Success',
  });
  const download = (redCapable: boolean, user: { id: number; isModerator?: boolean } = { id: 1 }) =>
    getFileForModelVersion({
      modelVersionId: 1,
      type: 'Training Data',
      user,
      attribution: { path: 'test', actor: 'test' } as never,
      redCapable,
    });

  beforeEach(() => {
    versionRead.mockReset().mockResolvedValue(publishedModelVersion());
    hasEntityAccessMock.mockReset().mockResolvedValue([{ hasAccess: true, permissions: 0 }]);
    getPaidAccessMock.mockReset().mockResolvedValue({});
    resolveDownloadUrlMock
      .mockReset()
      .mockResolvedValue({ url: 'https://cdn/data.zip', urlExpiryDate: new Date() });
    shareRestrictedMock.mockReset().mockResolvedValue(false);
  });

  it.each([
    ['a mature zip', { nsfwLevel: MATURE }, false, 'not-found'],
    ['a mature zip', { nsfwLevel: MATURE }, true, 'success'],
    ['a PG-13 zip', { nsfwLevel: 2 | 1 }, false, 'success'],
    ['a classic unrated zip', {}, false, 'success'],
    ['a classic unrated zip', {}, true, 'success'],
    ['a fully rated SFW Studio zip', { nsfwLevel: 1, fullyRated: true }, false, 'success'],
    ['a partly rated Studio zip', { nsfwLevel: 1, fullyRated: false }, false, 'not-found'],
    ['a partly rated Studio zip', { nsfwLevel: 1, fullyRated: false }, true, 'success'],
    ['an unrated Studio zip', { fullyRated: false }, false, 'not-found'],
  ])('%s on a red-capable host %s is %s', async (_, metadata, redCapable, status) => {
    listDownloadFilesMock.mockReset().mockResolvedValue([datasetRated(metadata)]);
    const result = await download(redCapable);
    expect(result.status).toBe(status);
    if (status === 'not-found') expect(result).toEqual({ status: 'not-found' });
  });

  it('serves its owner their own mature zip off a red-capable host, and no one else', async () => {
    listDownloadFilesMock.mockReset().mockResolvedValue([datasetRated({ nsfwLevel: MATURE })]);
    expect((await download(false, { id: 999 })).status).toBe('success');
    expect(await download(false, { id: 1 })).toEqual({ status: 'not-found' });
  });

  it('serves its owner a partly rated Studio zip made Public off a red-capable host, and no one else', async () => {
    listDownloadFilesMock
      .mockReset()
      .mockResolvedValue([datasetRated({ nsfwLevel: 1, fullyRated: false })]);
    expect((await download(false, { id: 999 })).status).toBe('success');
    expect(await download(false, { id: 1 })).toEqual({ status: 'not-found' });
  });

  it('serves a moderator a mature zip off a red-capable host, and no one else', async () => {
    listDownloadFilesMock.mockReset().mockResolvedValue([datasetRated({ nsfwLevel: MATURE })]);
    expect((await download(false, { id: 1, isModerator: true })).status).toBe('success');
    expect(await download(false, { id: 1 })).toEqual({ status: 'not-found' });
  });

  it("serves a mature model's weights on any host", async () => {
    listDownloadFilesMock.mockReset().mockResolvedValue([aFile]);
    versionRead.mockResolvedValue(publishedModelVersion({ nsfwLevel: 28 }));
    const result = await getFileForModelVersion({
      modelVersionId: 1,
      user: { id: 1 },
      attribution: { path: 'test', actor: 'test' } as never,
      redCapable: false,
    });
    expect(result.status).toBe('success');
  });
});
