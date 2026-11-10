import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import type * as HotReads5 from '~/server/services/hot-reads-5.reads';
import type * as HotReads6 from '~/server/services/hot-reads-6.reads';
import type * as PaidAccess from '~/server/services/paid-access.service';
import type * as Caches from '~/server/redis/caches';
import type * as FileService from '~/server/services/file.service';
import type * as ReviewReads from '~/server/services/download-link/moderator-review.reads';

/**
 * `checkGenerationFetch` for a per-provider download token: what generation is served today, minus
 * removed, refused and in-review models. The gate runs for real; only its data reads are faked.
 */

const { world } = vi.hoisted(() => ({
  world: {
    versions: new Map<number, Record<string, any>>(),
    files: [] as Record<string, any>[],
    paidAccess: new Map<number, { endsAt: Date | null }>(),
    inReview: new Set<number>(),
    removedWithOwner: new Set<number>(),
  },
}));

vi.mock('~/server/db/kyselyDb.lazy', () => ({ loadKyselyDb: async () => ({ kyselyRead: {} }) }));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getDownloadFilename: ({ file }: { file: { name: string } }) => file.name,
}));
vi.mock('~/server/services/download-link/moderator-review.reads', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewReads>()),
  readModeratorFlags: async (_db: unknown, id: number) => ({
    inReview: world.inReview.has(id),
    removedWithOwner: world.removedWithOwner.has(id),
  }),
}));
vi.mock('~/server/services/hot-reads-5.reads', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  readModelVersionForFileViaKysely: async (_db: unknown, id: number) => {
    const v = world.versions.get(id);
    if (!v) return null;
    return {
      id: v.id,
      status: v.status,
      model: {
        id: v.id * 10,
        name: 'Model',
        type: 'Checkpoint',
        publishedAt: null,
        status: v.modelStatus,
        userId: 1,
        mode: v.mode,
        nsfw: false,
        availability: v.availability,
        poi: v.poi,
      },
      name: 'v1',
      trainedWords: [],
      createdAt: new Date(0),
      requireAuth: v.requireAuth,
      usageControl: v.usageControl,
      baseModel: 'SDXL 1.0',
    };
  },
}));
vi.mock('~/server/services/hot-reads-6.reads', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  readDownloadFilesViaKysely: async (
    _db: unknown,
    where: { modelVersionId: number; publicOnly?: boolean; type?: string }
  ) =>
    world.files.filter(
      (f) =>
        f.versionId === where.modelVersionId &&
        (!where.publicOnly || f.visibility === 'Public') &&
        (!where.type || f.type === where.type)
    ),
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccess>()),
  getPaidAccess: async (_type: string, ids: number[]) =>
    Object.fromEntries(
      ids.filter((id) => world.paidAccess.has(id)).map((id) => [id, world.paidAccess.get(id)])
    ),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  lookupModelVersionAccess: async (ids: number[]) =>
    Object.fromEntries(
      ids
        .filter((id) => world.versions.has(id))
        .map((id) => [
          id,
          { entityId: id, userId: 1, availability: world.versions.get(id)!.availability },
        ])
    ),
}));

import {
  checkGenerationFetch,
  clearGateReadCache,
} from '~/server/services/download-link/generation-fetch.service';

let nextId = 1;
function version(overrides: Record<string, unknown> = {}, files: Record<string, unknown>[] = [{}]) {
  const id = nextId++;
  world.versions.set(id, {
    id,
    status: 'Published',
    modelStatus: 'Published',
    mode: null,
    poi: false,
    availability: 'Public',
    requireAuth: false,
    usageControl: 'Download',
    ...overrides,
  });
  files.forEach((file, i) =>
    world.files.push({
      id: id * 100 + i,
      versionId: id,
      url: `https://bucket/${id}-${i}.safetensors`,
      name: `${id}-${i}.safetensors`,
      overrideName: null,
      type: 'Model',
      metadata: {},
      sizeKB: 1000,
      pickleScanResult: 'Success',
      virusScanResult: 'Success',
      visibility: 'Public',
      hashes: [],
      ...file,
    })
  );
  return id;
}

const asProvider = (modelVersionId: number, extra: Record<string, unknown> = {}) =>
  checkGenerationFetch({
    modelVersionId,
    principal: { kind: 'provider', provider: 'RunPods' },
    ...extra,
  });
const asAnonymous = (modelVersionId: number) =>
  checkGenerationFetch({ modelVersionId, principal: null });

beforeEach(() => {
  resetEnv();
  world.versions.clear();
  world.files.length = 0;
  world.paidAccess.clear();
  world.inReview.clear();
  world.removedWithOwner.clear();
  clearGateReadCache();
});

describe('a provider is served what generation is served', () => {
  it.each([
    ['a published version', {}],
    ['an unpublished version', { status: 'Unpublished' }],
    ['a draft', { status: 'Draft', modelStatus: 'Draft' }],
    ['a scheduled version', { status: 'Scheduled' }],
    ['a private version', { availability: 'Private' }],
    ['a generation-only version', { usageControl: 'Generation' }],
    ['an internal-generation version', { usageControl: 'InternalGeneration' }],
    ['a version that requires sign-in', { requireAuth: true }],
  ])('%s', async (_label, overrides) => {
    const id = version(overrides);
    expect(await asProvider(id)).toMatchObject({ ok: true, fileId: id * 100 });
  });

  it('an early-access version', async () => {
    const id = version();
    world.paidAccess.set(id, { endsAt: null });
    expect(await asProvider(id)).toMatchObject({ ok: true, inEarlyAccess: true });
  });

  it("the version's non-public file, by id", async () => {
    const id = version({}, [{}, { visibility: 'Private' }]);
    expect(await asProvider(id, { fileId: id * 100 + 1 })).toMatchObject({
      ok: true,
      fileId: id * 100 + 1,
      isPublic: false,
    });
  });
});

describe('a provider is refused', () => {
  it.each([
    ['a deleted model', { modelStatus: 'Deleted' }, 'not-found'],
    ['a deleted version', { status: 'Deleted' }, 'not-found'],
    ['a version removed for a violation', { status: 'UnpublishedViolation' }, 'not-found'],
    ['a model removed for a violation', { modelStatus: 'UnpublishedViolation' }, 'not-found'],
    ['a model still training', { status: 'Training', modelStatus: 'Training' }, 'not-found'],
    ['a gather-interest model', { modelStatus: 'GatherInterest' }, 'not-found'],
    ['a taken-down model', { mode: 'TakenDown' }, 'not-found'],
    ['an archived model', { mode: 'Archived' }, 'archived'],
    ['a POI model', { poi: true }, 'poi'],
  ])('%s', async (_label, overrides, error) => {
    expect(await asProvider(version(overrides))).toEqual({ ok: false, error });
  });

  it('a model in moderator review', async () => {
    const id = version();
    world.inReview.add(id);
    expect(await asProvider(id)).toEqual({ ok: false, error: 'in-review' });
  });

  it("a draft kept after its owner's content was removed", async () => {
    const id = version({ status: 'Draft', modelStatus: 'Draft' });
    // Control: the same draft is served without the flag.
    expect(await asProvider(id)).toMatchObject({ ok: true });
    world.removedWithOwner.add(id);
    clearGateReadCache();
    expect(await asProvider(id)).toEqual({ ok: false, error: 'not-found' });
  });

  it('a failed scan', async () => {
    const id = version({}, [{ virusScanResult: 'Danger' }]);
    expect(await asProvider(id)).toEqual({ ok: false, error: 'failed-scan' });
  });

  it('training data', async () => {
    const id = version({}, [{ type: 'Training Data' }]);
    expect(await asProvider(id, { fileId: id * 100 })).toEqual({ ok: false, error: 'not-found' });
  });
});

describe("a provider's file selectors", () => {
  it('pick the requested format, not the primary file', async () => {
    const id = version({}, [
      { metadata: { format: 'SafeTensor', fp: 'fp16' } },
      { metadata: { format: 'GGUF', fp: 'fp16' } },
    ]);
    expect(await asProvider(id, { selectors: { format: 'GGUF' } })).toMatchObject({
      ok: true,
      fileId: id * 100 + 1,
    });
  });

  // Each wanted value is the one the default file preference would NOT pick.
  it.each([
    ['size', 'pruned', 'full'],
    ['fp', 'fp16', 'fp8'],
    ['quantType', 'Q4_K_M', 'Q8_0'],
  ] as const)('pick the requested %s, not the primary file', async (key, primary, wanted) => {
    const id = version({}, [
      { metadata: { format: 'GGUF', [key]: primary } },
      { metadata: { format: 'GGUF', [key]: wanted } },
    ]);
    expect(await asProvider(id, { selectors: { [key]: wanted } })).toMatchObject({
      ok: true,
      fileId: id * 100 + 1,
    });
  });

  it('pick the requested type', async () => {
    const id = version({}, [{}, { type: 'Config' }]);
    expect(await asProvider(id, { selectors: { type: 'Config' } })).toMatchObject({
      ok: true,
      fileId: id * 100 + 1,
    });
  });

  it('refuse a component the version does not carry, rather than serve the primary file', async () => {
    const id = version();
    expect(await asProvider(id, { selectors: { type: 'VAE' } })).toEqual({
      ok: false,
      error: 'unsupported-file',
    });
  });

  it('refuse a selector the only file contradicts', async () => {
    const id = version({}, [{ metadata: { format: 'SafeTensor' } }]);
    expect(await asProvider(id, { selectors: { format: 'GGUF' } })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });
});

describe('a provider download is labelled public only when anyone could download the file', () => {
  // On, so each nonpublic row below is decided by its own condition, not by sign-in.
  beforeEach(() => setEnv({ UNAUTHENTICATED_DOWNLOAD: true }));

  it('public for a public file anyone can download', async () => {
    const id = version();
    expect(await asAnonymous(id)).toMatchObject({ ok: true });
    expect(await asProvider(id)).toMatchObject({ ok: true, isPublic: true });
  });

  it('public for a public file requested by id', async () => {
    const id = version({}, [{}, { visibility: 'Private' }]);
    expect(await asProvider(id, { fileId: id * 100 })).toMatchObject({ ok: true, isPublic: true });
  });

  it('nonpublic for a private file requested by id', async () => {
    const id = version({}, [{}, { visibility: 'Private' }]);
    expect(await asProvider(id, { fileId: id * 100 + 1 })).toMatchObject({
      ok: true,
      isPublic: false,
    });
  });

  it('nonpublic for an early-access version', async () => {
    const id = version();
    world.paidAccess.set(id, { endsAt: null });
    expect(await asProvider(id)).toMatchObject({ ok: true, isPublic: false });
  });

  it('nonpublic for every file while downloads require sign-in', async () => {
    setEnv({ UNAUTHENTICATED_DOWNLOAD: false });
    expect(await asProvider(version())).toMatchObject({ ok: true, isPublic: false });
  });

  it.each([
    ['private', { availability: 'Private' }],
    ['unpublished', { status: 'Unpublished' }],
    ['generation-only', { usageControl: 'Generation' }],
    ['sign-in-required', { requireAuth: true }],
  ])('nonpublic for a %s version', async (_label, overrides) => {
    expect(await asProvider(version(overrides))).toMatchObject({ ok: true, isPublic: false });
  });
});

describe('the provider widening is the provider principal only', () => {
  it('an anonymous fetch of an unpublished version is still refused', async () => {
    expect(await asAnonymous(version({ status: 'Unpublished' }))).toEqual({
      ok: false,
      error: 'not-found',
    });
  });
});
