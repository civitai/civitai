import { describe, expect, it } from 'vitest';
import { toggleableBrowsingCategories } from '~/shared/constants/browsingLevel.constants';

describe('toggleableBrowsingCategories', () => {
  it('keeps the browsing settings chips and the tags each one hides', () => {
    expect(toggleableBrowsingCategories).toEqual([
      {
        title: 'Hide anime',
        relatedTags: [
          { id: 4, name: 'anime' },
          { id: 413, name: 'manga' },
        ],
      },
      {
        title: 'Hide furry',
        relatedTags: [
          { id: 5139, name: 'anthro' },
          { id: 5140, name: 'furry' },
        ],
      },
      {
        title: 'Hide gore',
        relatedTags: [
          { id: 1282, name: 'gore' },
          { id: 789, name: 'body horror' },
        ],
      },
      { title: 'Hide political', relatedTags: [{ id: 2470, name: 'political' }] },
    ]);
  });
});
