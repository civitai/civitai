import { describe, expect, it, vi } from 'vitest';

import { ModelSort } from '~/server/common/enums';
import { modelsSortableAttributes } from '~/server/search-index/sortable-attributes';

vi.mock('~/server/meilisearch/client', () => ({
  searchClient: undefined,
  withMeili: (_label: string, fn: () => unknown) => fn(),
  MeiliCallTimeoutError: class extends Error {},
}));
vi.mock('~/server/services/model.service', () => ({ getModelsWithVersions: vi.fn() }));
vi.mock('~/server/services/file.service', () => ({ getDownloadFilename: vi.fn() }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/common/model-helpers', () => ({ createModelFileDownloadUrl: vi.fn() }));

import { meiliSortForModelSort } from '~/server/services/model-search.service';

describe('meiliSortForModelSort', () => {
  it('maps each ModelSort exactly, with id:desc as the tiebreak', () => {
    expect(meiliSortForModelSort(ModelSort.HighestRated)).toEqual([
      'metrics.thumbsUpCount:desc',
      'id:desc',
    ]);
    expect(meiliSortForModelSort(ModelSort.MostLiked)).toEqual([
      'metrics.thumbsUpCount:desc',
      'id:desc',
    ]);
    expect(meiliSortForModelSort(ModelSort.MostDownloaded)).toEqual([
      'metrics.downloadCount:desc',
      'id:desc',
    ]);
    expect(meiliSortForModelSort(ModelSort.MostDiscussed)).toEqual([
      'metrics.commentCount:desc',
      'id:desc',
    ]);
    expect(meiliSortForModelSort(ModelSort.MostCollected)).toEqual([
      'metrics.collectedCount:desc',
      'id:desc',
    ]);
    expect(meiliSortForModelSort(ModelSort.Newest)).toEqual(['createdAt:desc', 'id:desc']);
    expect(meiliSortForModelSort(ModelSort.Oldest)).toEqual(['createdAt:asc', 'id:desc']);
  });

  it('leaves the sorts with no sortable attribute, and no sort at all, on relevance', () => {
    expect(meiliSortForModelSort(ModelSort.ImageCount)).toBeUndefined();
    expect(meiliSortForModelSort(ModelSort.RecentlyAdded)).toBeUndefined();
    expect(meiliSortForModelSort(undefined)).toBeUndefined();
  });

  // An attribute the index cannot sort on is a Meili 400 on every query that carries it.
  it('only ever names attributes the models index declares sortable', () => {
    for (const sort of Object.values(ModelSort)) {
      for (const entry of meiliSortForModelSort(sort) ?? []) {
        const attribute = entry.replace(/:(asc|desc)$/, '');
        expect(modelsSortableAttributes, `${sort} → ${entry}`).toContain(attribute);
      }
    }
  });
});
