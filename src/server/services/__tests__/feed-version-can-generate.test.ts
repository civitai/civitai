import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { feedVersionCanGenerate, getModelsRaw } from '~/server/services/model.service';
import '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

// Same import-chain stubs as get-models-raw.transient-503.test.ts: model.service otherwise pulls
// the event-engine submodule through image.service and flipt.
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn().mockResolvedValue(false),
  FLIPT_FEATURE_FLAGS: {},
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
const { modelQueries } = vi.hoisted(() => ({ modelQueries: [] as Prisma.Sql[] }));
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: async (query: Prisma.Sql) => {
      modelQueries.push(query);
      return { result: async () => [] };
    },
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

const FREE = { next: true, member: false };
const MEMBER = { next: true, member: true };

// A community checkpoint the staged rule covers but the live (auction) rule does not.
const expansionOnly = { covered: false, coveredNext: true, baseModel: 'SDXL 1.0', flags: 0 };
const cold = { generatorLoaded: false };
const loaded = { generatorLoaded: true };

const canGenerate = (args: Partial<Parameters<typeof feedVersionCanGenerate>[0]>) =>
  feedVersionCanGenerate({
    version: expansionOnly,
    modelType: 'Checkpoint',
    next: true,
    ...args,
  });

describe('feedVersionCanGenerate', () => {
  // The card offered Create, and the submit refused with "Some of your resources are not
  // available for generation", because the feed ignored the viewer's tier.
  it('refuses a free account an expansion checkpoint that is not loaded', () => {
    expect(canGenerate({ coverage: FREE, readiness: cold })).toBe(false);
  });

  it('allows a member the same checkpoint', () => {
    expect(canGenerate({ coverage: MEMBER, readiness: cold })).toBe(true);
  });

  it('allows a free account once the checkpoint is loaded', () => {
    expect(canGenerate({ coverage: FREE, readiness: loaded })).toBe(true);
  });

  it('allows a free account an auction-covered checkpoint that is not loaded', () => {
    expect(
      canGenerate({
        version: { ...expansionOnly, covered: true },
        coverage: FREE,
        readiness: cold,
      })
    ).toBe(true);
  });

  // The shared home-block cache passes no audience: its stored answer must not depend on the
  // first viewer to fill it.
  it('without an audience, keeps the audience-blind answer', () => {
    expect(canGenerate({ coverage: undefined, readiness: cold })).toBe(true);
  });
});

describe('getModelsRaw supportsGeneration', () => {
  const capturedSql = async (coverage?: { next: boolean; member: boolean }) => {
    modelQueries.length = 0;
    await getModelsRaw({
      input: { supportsGeneration: true, browsingLevel: 1, take: 10 } as never,
      coverage,
    });
    return modelQueries.map((q) => q.sql).join('\n');
  };

  it('narrows the filter to loaded checkpoints for a free account', async () => {
    expect(await capturedSql(FREE)).toContain('"generatorLoaded"');
  });

  it('keeps the plain coverage column without an audience', async () => {
    const sql = await capturedSql(undefined);
    expect(sql).toContain('GenerationCoverage');
    expect(sql).not.toContain('"generatorLoaded"');
  });
});
