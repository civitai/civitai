import { describe, expect, it } from 'vitest';
import { modelFeedUrlFromLegacySearch } from '~/components/Model/Infinite/model-feed-search';

const searchParams = (url: string) => new URL(url, 'https://x').searchParams;

describe('modelFeedUrlFromLegacySearch', () => {
  it("carries an old models search onto the feed's own filters", () => {
    const url = modelFeedUrlFromLegacySearch({
      query: 'anime',
      users: 'someone',
      baseModel: ['SDXL 1.0', 'Pony'],
      modelType: 'LORA',
      checkpointType: 'Merge',
    });
    expect(url.startsWith('/models?')).toBe(true);
    const params = searchParams(url);
    expect(params.get('query')).toBe('anime');
    expect(params.get('username')).toBe('someone');
    expect(params.getAll('baseModels')).toEqual(['SDXL 1.0', 'Pony']);
    expect(params.getAll('types')).toEqual(['LORA']);
    expect(params.get('checkpointType')).toBe('Merge');
  });

  it('folds tags and categories into the query', () => {
    const url = modelFeedUrlFromLegacySearch({
      query: 'girl',
      tags: 'anime',
      category: 'character',
    });
    expect(searchParams(url).get('query')).toBe('girl anime character');
  });

  it('lands an empty search on the bare feed', () => {
    expect(modelFeedUrlFromLegacySearch({})).toBe('/models');
  });
});
