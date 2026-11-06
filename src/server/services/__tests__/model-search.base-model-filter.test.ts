import { describe, it, expect, vi, beforeEach } from 'vitest';

import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * `baseModels` and `supportsGeneration` must filter INSIDE the Meili query. Applied only in the DB,
 * they intersect Meili's top limit+1 relevance hits, so a query whose best hits are on other base
 * models returns an empty page while matching models sit further down.
 *
 * The fake index applies the filter clauses the service sends, evaluating only the `IN [...]` and
 * `= true` shapes it uses.
 */

type Doc = {
  id: number;
  nsfwLevel: number;
  type: string;
  canGenerate: boolean;
  canGenerateNext: boolean;
  versions: { baseModel: string }[];
};

const { mockSearch, coverage } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  coverage: { next: false },
}));

vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index: () => ({ search: mockSearch }) },
  withMeili: (_label: string, fn: () => unknown) => fn(),
  MeiliCallTimeoutError: class extends Error {},
  isTransientMeiliError: () => false,
}));
vi.mock('~/server/services/generation/coverage-source', () => ({
  nextCoverageEnabled: async () => coverage.next,
}));
vi.mock('~/server/services/model.service', () => ({ getModelsWithVersions: vi.fn() }));
vi.mock('~/server/services/file.service', () => ({ getDownloadFilename: vi.fn() }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/common/model-helpers', () => ({ createModelFileDownloadUrl: vi.fn() }));

import { resolveModelSearchIds } from '~/server/services/model-search.service';

function fieldValues(doc: Doc, field: string): unknown[] {
  if (field === 'versions.baseModel') return doc.versions.map((v) => v.baseModel);
  return [(doc as Record<string, unknown>)[field]];
}

function matches(doc: Doc, clause: string): boolean {
  const inMatch = clause.match(/^(\S+) IN \[(.*)\]$/);
  if (inMatch) {
    const items = [...inMatch[2].matchAll(/"((?:[^"\\]|\\.)*)"|[^,\s]+/g)].map((m) =>
      m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[0]
    );
    return fieldValues(doc, inMatch[1]).some((v) => items.includes(String(v)));
  }
  const eqTrue = clause.match(/^(\S+) = true$/);
  if (eqTrue) return fieldValues(doc, eqTrue[1]).includes(true);
  throw new Error(`fake index cannot evaluate: ${clause}`);
}

function serveFrom(corpus: Doc[]) {
  mockSearch.mockImplementation(
    async (_q: string, opts: { offset?: number; limit?: number; filter: string[] }) => {
      const hits = corpus.filter((doc) => opts.filter.every((c) => matches(doc, c)));
      const offset = opts.offset ?? 0;
      return { hits: hits.slice(offset, offset + (opts.limit ?? 20)).map(({ id }) => ({ id })) };
    }
  );
}

const doc = (id: number, baseModel: string, canGenerate = false, canGenerateNext = false): Doc => ({
  id,
  nsfwLevel: 1,
  type: 'LORA',
  canGenerate,
  canGenerateNext,
  versions: [{ baseModel }],
});

// Relevance order: the twelve best hits are SDXL, the SD 3.5 Large models come after.
const corpus = [
  ...Array.from({ length: 12 }, (_, i) => doc(i + 1, 'SDXL 1.0')),
  doc(101, 'SD 3.5 Large', true),
  doc(102, 'SD 3.5 Large', false, true),
  doc(103, 'SD 3.5 Large', true, true),
];

const baseOpts = { query: 'fantasy', limit: 5, browsingLevel: allBrowsingLevelsFlag };

describe('resolveModelSearchIds base model and generation filters', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    coverage.next = false;
    serveFrom(corpus);
  });

  it('returns matching models that rank below the first page of hits', async () => {
    const { searchIds } = await resolveModelSearchIds({
      ...baseOpts,
      baseModels: ['SD 3.5 Large'],
    });
    expect(searchIds).toEqual([101, 102, 103]);
  });

  it('quotes names with spaces and dots', async () => {
    await resolveModelSearchIds({ ...baseOpts, baseModels: ['SD 3.5 Large', 'Flux.1 D'] });
    expect(mockSearch.mock.calls[0][1].filter).toContain(
      'versions.baseModel IN ["SD 3.5 Large", "Flux.1 D"]'
    );
  });

  it('pages through the filtered hits by offset', async () => {
    const first = await resolveModelSearchIds({
      ...baseOpts,
      limit: 2,
      baseModels: ['SD 3.5 Large'],
    });
    expect(first).toEqual({ searchIds: [101, 102], nextCursor: '2' });
    const second = await resolveModelSearchIds({
      ...baseOpts,
      limit: 2,
      cursor: first.nextCursor,
      baseModels: ['SD 3.5 Large'],
    });
    expect(second).toEqual({ searchIds: [103], nextCursor: undefined });
  });

  it('filters supportsGeneration on the column the coverage flag selects', async () => {
    const live = await resolveModelSearchIds({
      ...baseOpts,
      baseModels: ['SD 3.5 Large'],
      supportsGeneration: true,
    });
    expect(live.searchIds).toEqual([101, 103]);

    coverage.next = true;
    const next = await resolveModelSearchIds({
      ...baseOpts,
      baseModels: ['SD 3.5 Large'],
      supportsGeneration: true,
    });
    expect(next.searchIds).toEqual([102, 103]);
  });

  it('adds neither filter when they are absent or empty', async () => {
    await resolveModelSearchIds({ ...baseOpts, baseModels: [], supportsGeneration: false });
    expect(mockSearch.mock.calls[0][1].filter).toEqual([expect.stringMatching(/^nsfwLevel IN \[/)]);
  });
});
