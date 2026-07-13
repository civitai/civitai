import { describe, it, expect, vi, beforeEach } from 'vitest';

import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * Non-mocked test for the type filter INSIDE `resolveModelSearchIds`. The
 * endpoint tests mock the whole service, so they only prove `types` is
 * forwarded — this proves it lands in the actual Meili filter expression.
 * Without the in-query filter, `query` + `types` intersected the top-N
 * relevance hits (of ANY type) with the type filter in the DB, which returned
 * empty pages for sparse types (verified on prod: `query=fantasy&
 * types=Wildcards` → 0 items while a fantasy wildcard pack sits at #3 by
 * downloads).
 */

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));

vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index: () => ({ search: mockSearch }) },
  withMeili: (_label: string, fn: () => unknown) => fn(),
  MeiliCallTimeoutError: class extends Error {},
}));
vi.mock('~/server/services/model.service', () => ({ getModelsWithVersions: vi.fn() }));
vi.mock('~/server/services/file.service', () => ({ getDownloadFilename: vi.fn() }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/common/model-helpers', () => ({ createModelFileDownloadUrl: vi.fn() }));

import { resolveModelSearchIds } from '~/server/services/model-search.service';

const baseOpts = { query: 'fantasy', limit: 10, browsingLevel: allBrowsingLevelsFlag };

describe('resolveModelSearchIds type filter', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockSearch.mockResolvedValue({ hits: [] });
  });

  function searchFilter(): string[] {
    return mockSearch.mock.calls[0][1].filter;
  }

  it('adds a type IN filter when types are given', async () => {
    await resolveModelSearchIds({ ...baseOpts, types: ['Wildcards'] });
    expect(searchFilter()).toContain('type IN [Wildcards]');
  });

  it('supports multiple types', async () => {
    await resolveModelSearchIds({ ...baseOpts, types: ['Checkpoint', 'LORA'] });
    expect(searchFilter()).toContain('type IN [Checkpoint,LORA]');
  });

  it('omits the type filter when types are absent (behavior unchanged)', async () => {
    await resolveModelSearchIds(baseOpts);
    expect(searchFilter().some((f) => f.startsWith('type'))).toBe(false);
  });

  it('drops values that are not ModelType members (block schema accepts raw strings)', async () => {
    await resolveModelSearchIds({
      ...baseOpts,
      // 'toString' guards against prototype-chain membership checks (`in`).
      types: ['Wildcards', 'NotAType', 'toString', 'x = 1 OR type IN [Checkpoint]'],
    });
    expect(searchFilter()).toContain('type IN [Wildcards]');
  });

  it('omits the filter entirely when no given type is valid', async () => {
    await resolveModelSearchIds({ ...baseOpts, types: ['NotAType'] });
    expect(searchFilter().some((f) => f.startsWith('type'))).toBe(false);
  });

  it('keeps the nsfwLevel filter alongside the type filter', async () => {
    await resolveModelSearchIds({ ...baseOpts, types: ['Wildcards'] });
    expect(searchFilter().some((f) => f.startsWith('nsfwLevel IN ['))).toBe(true);
  });
});
