import { describe, expect, it } from 'vitest';
import {
  getFeedSources,
  resolveFeedSource,
  summarizeFeedSources,
} from '~/components/Image/image.utils';

// The BitDex feed notice is gated on resolveFeedSource. BitDex falls back to
// Meili per page, so "some page was BitDex" is not the same question as "BitDex
// is serving this feed" — answering the first puts a "we're testing a new
// system" notice over Meilisearch results.
describe('getFeedSources', () => {
  it('reports the backend of each page in order', () => {
    expect(getFeedSources([{ source: 'bitdex' }, { source: 'meili' }])).toEqual([
      'bitdex',
      'meili',
    ]);
  });

  it('reports none for a page that carried no backend at all', () => {
    expect(getFeedSources([{ items: [] }])).toEqual(['none']);
  });

  it('reports nothing for a feed that has loaded no pages', () => {
    expect(getFeedSources(undefined)).toEqual([]);
  });
});

describe('resolveFeedSource', () => {
  it('answers meili once BitDex has fallen back, even though BitDex served page 1', () => {
    expect(resolveFeedSource(['bitdex', 'meili', 'meili'])).toBe('meili');
  });

  it('answers bitdex while BitDex is still serving', () => {
    expect(resolveFeedSource(['bitdex', 'bitdex'])).toBe('bitdex');
  });

  // Scrolling to the end of a feed appends an empty, sourceless terminal page.
  // Treating that as a switch would retract the notice at the exact moment the
  // user has seen the most.
  it('ignores a sourceless terminal page and keeps the backend that served the scroll', () => {
    expect(resolveFeedSource(['bitdex', 'bitdex', 'none'])).toBe('bitdex');
  });

  it('answers nothing when no page reported a backend', () => {
    expect(resolveFeedSource(['none'])).toBeUndefined();
    expect(resolveFeedSource([])).toBeUndefined();
  });
});

describe('summarizeFeedSources', () => {
  // A raw join truncated to a fixed width drops the tail — which is the half the
  // gate reads, so the record would contradict its own reportedSource.
  it('keeps both ends of a deep scroll inside a bounded width', () => {
    const sources = [...Array(28).fill('bitdex'), ...Array(12).fill('meili')];

    const summary = summarizeFeedSources(sources);

    expect(summary).toBe('bitdexx28,meilix12');
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('keeps runs distinct when a feed flips back and forth', () => {
    expect(summarizeFeedSources(['bitdex', 'meili', 'bitdex'])).toBe('bitdex,meili,bitdex');
  });
});
