import { describe, expect, it, vi, beforeEach } from 'vitest';

import type * as MeiliClient from '~/server/meilisearch/client';
import type * as CoverageSource from '~/server/services/generation/coverage-source';

/**
 * Stage-2 matcher tests. The matcher is the deterministic gate owner: Jev can
 * reorder/drop within its shortlist but never add — the cap, the per-version
 * gates and the filter are all enforced HERE, in code. The filter-string
 * assertions read the query the Meilisearch client is actually handed (the
 * pattern from resource-select.pricing-filter.test.ts).
 */

const searchWithSignal = vi.fn();
// Live-binding holder so a test can observe the meili-unconfigured path.
const meiliHolder: { client: unknown } = { client: { index: () => ({}) } };

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  get searchClient() {
    return meiliHolder.client;
  },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));

vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const { buildResourceIntentFilter, expandShortlist, findResourceIntentCandidates } = await import(
  '~/server/services/resource-intent-matcher.service'
);
const { RESOURCE_INTENT_MAX_SHORTLIST } = await import('~/server/schema/resource-intent.schema');

const COVERAGE = { next: false, member: false };

const shortlistHit = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 1,
    name: 'Test LoRA',
    type: 'LORA',
    metrics: { thumbsUpCount: 100 },
    versions: [{ id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
    ...overrides,
  } as never);

const meiliArgsOf = () =>
  (searchWithSignal.mock.calls[0][2] ?? {}) as {
    filter?: string;
    sort?: string[];
    limit?: number;
  };

beforeEach(() => {
  meiliHolder.client = { index: () => ({}) };
  searchWithSignal.mockReset();
  searchWithSignal.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });
});

describe('buildResourceIntentFilter — the deterministic gates reach Meilisearch', () => {
  it('emits availability, maturity, type+baseModel and celebrity clauses', () => {
    const filter = buildResourceIntentFilter({
      modelTypes: ['LORA', 'TextualInversion'],
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(filter).toContain('availability != "Private"');
    // The browsing-level bits, mirroring model.service's `nsfwLevel IN [...]`.
    expect(filter).toContain('nsfwLevel IN [1, 2]');
    expect(filter).toContain('type = "LORA"');
    expect(filter).toContain('versions.baseModel IN ["SDXL 1.0"]');
    expect(filter).toContain('canGenerate = true');
    expect(filter).toContain('NOT tags.name = "celebrity"');
  });

  it('omits the type clause when the role mapping has none', () => {
    const filter = buildResourceIntentFilter({
      modelTypes: null,
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(filter).not.toContain('type =');
    expect(filter).toContain('versions.baseModel IN ["SDXL 1.0"]');
  });

  it('omits the baseModel clause when no baseModel was supplied', () => {
    const filter = buildResourceIntentFilter({
      modelTypes: ['LORA'],
      baseModels: null,
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(filter).toContain('type = "LORA"');
    expect(filter).not.toContain('versions.baseModel');
  });

  it('is deterministic for identical inputs', () => {
    const a = buildResourceIntentFilter({
      modelTypes: ['LORA'],
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    const b = buildResourceIntentFilter({
      modelTypes: ['LORA'],
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(a).toBe(b);
  });
});

describe('expandShortlist — determinism, cap, gates', () => {
  it('expands model hits to versions in hit order and is deterministic', () => {
    const hits = [
      shortlistHit({
        id: 1,
        versions: [
          { id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true },
          { id: 12, name: 'v2', baseModel: 'SDXL 1.0', canGenerate: true },
        ],
      }),
      shortlistHit({
        id: 2,
        versions: [{ id: 21, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
      }),
    ];
    const first = expandShortlist(hits, { baseModels: ['SDXL 1.0'], coverage: COVERAGE, cap: 50 });
    const second = expandShortlist(hits, { baseModels: ['SDXL 1.0'], coverage: COVERAGE, cap: 50 });
    expect(first.map((e) => e.versionId)).toEqual([11, 12, 21]);
    expect(second).toEqual(first);
  });

  it('enforces the cap exactly', () => {
    const hits = [
      shortlistHit({
        versions: Array.from({ length: 300 }, (_, i) => ({
          id: i + 1,
          name: `v${i}`,
          baseModel: 'SDXL 1.0',
          canGenerate: true,
        })),
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: RESOURCE_INTENT_MAX_SHORTLIST,
    });
    expect(entries).toHaveLength(RESOURCE_INTENT_MAX_SHORTLIST);
    expect(entries[0].versionId).toBe(1);
    expect(entries.at(-1)?.versionId).toBe(RESOURCE_INTENT_MAX_SHORTLIST);
  });

  it('drops versions whose baseModel does not match — a gate Jev cannot veto', () => {
    const hits = [
      shortlistHit({
        versions: [
          { id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true },
          { id: 12, name: 'v2', baseModel: 'Pony', canGenerate: true },
        ],
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries.map((e) => e.versionId)).toEqual([11]);
  });

  it('drops versions failing the per-version coverage gate', () => {
    const hits = [
      shortlistHit({
        versions: [
          { id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true },
          { id: 12, name: 'v2', baseModel: 'SDXL 1.0', canGenerate: false },
        ],
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries.map((e) => e.versionId)).toEqual([11]);
  });

  it('never returns duplicate version ids', () => {
    const hits = [
      shortlistHit({
        id: 1,
        versions: [{ id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
      }),
      shortlistHit({
        id: 2,
        versions: [{ id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries).toHaveLength(1);
  });
});

describe('findResourceIntentCandidates', () => {
  const criteria = {
    criteriaVersion: 1,
    specHash: 'abc',
    role: 'style' as const,
    modelTypes: ['LORA', 'TextualInversion'] as never,
    baseModel: 'SDXL 1.0',
  };

  it('queries with the popularity sort and returns the capped shortlist', async () => {
    searchWithSignal.mockResolvedValue({ hits: [shortlistHit()], estimatedTotalHits: 1 });
    const entries = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    const args = meiliArgsOf();
    expect(args.sort).toEqual(['metrics.thumbsUpCount:desc']);
    expect(args.limit).toBeGreaterThanOrEqual(50);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ versionId: 11, modelType: 'LORA', baseModel: 'SDXL 1.0' });
  });

  it('returns [] without querying when the role is none', async () => {
    const entries = await findResourceIntentCandidates(
      { ...criteria, role: 'none', modelTypes: null },
      { browsingLevel: 3, coverage: COVERAGE, cap: 50 }
    );
    expect(entries).toEqual([]);
    expect(searchWithSignal).not.toHaveBeenCalled();
  });

  it('returns [] without querying when Meilisearch is not configured', async () => {
    meiliHolder.client = null;
    const entries = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries).toEqual([]);
    expect(searchWithSignal).not.toHaveBeenCalled();
  });

  it('surfaces a search failure as a thrown error (the service degrades)', async () => {
    searchWithSignal.mockRejectedValue(new Error('meili down'));
    await expect(
      findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 50 })
    ).rejects.toThrow('meili down');
  });
});
