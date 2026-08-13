import { describe, expect, it } from 'vitest';
import { getFeedSources } from '~/components/Image/image.utils';

// The BitDex feed notice is gated on the LAST entry of this list. BitDex falls
// back to Meili per page, so "some page was BitDex" is not the same question as
// "BitDex is serving this feed", and answering the wrong one puts a
// "we're testing a new system" notice over Meilisearch results.
describe('getFeedSources', () => {
  it('reports the backend of each page in order', () => {
    expect(getFeedSources([{ source: 'bitdex' }, { source: 'meili' }])).toEqual([
      'bitdex',
      'meili',
    ]);
  });

  it('leaves the LAST page as meili when BitDex served only the first page', () => {
    const sources = getFeedSources([
      { source: 'bitdex' },
      { source: 'meili' },
      { source: 'meili' },
    ]);

    expect(sources[sources.length - 1]).toBe('meili');
  });

  it('reports db for a page from the raw-SQL branch, which emits no source', () => {
    expect(getFeedSources([{ items: [] }])).toEqual(['db']);
  });

  it('reports nothing for a feed that has loaded no pages', () => {
    expect(getFeedSources(undefined)).toEqual([]);
  });
});
