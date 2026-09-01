import { describe, expect, it } from 'vitest';
import {
  buildFeedSnapshot,
  getFeedSources,
  resolveFeedSource,
} from '~/components/Image/image.utils';

// The feed notice is gated on resolveFeedSource. The index falls back to the
// DB per page, so "some page was served by the index" is not the same question as "the index
// is serving this feed" — answering the first puts a "we're testing a new
// system" notice over Meilisearch results.
describe('getFeedSources', () => {
  it('reports the backend of each page in order', () => {
    expect(getFeedSources([{ source: 'meili' }, { source: 'db' }])).toEqual(['meili', 'db']);
  });

  it('reports none for a page that carried no backend at all', () => {
    expect(getFeedSources([{ items: [] }])).toEqual(['none']);
  });

  it('reports nothing for a feed that has loaded no pages', () => {
    expect(getFeedSources(undefined)).toEqual([]);
  });
});

describe('resolveFeedSource', () => {
  it('answers db once the index has fallen back, even though the index served page 1', () => {
    expect(resolveFeedSource(['meili', 'db', 'db'])).toBe('db');
  });

  it('answers meili while the index is still serving', () => {
    expect(resolveFeedSource(['meili', 'meili'])).toBe('meili');
  });

  // Scrolling to the end of a feed appends an empty, sourceless terminal page.
  // Treating that as a switch would retract the notice at the exact moment the
  // user has seen the most.
  it('ignores a sourceless terminal page and keeps the backend that served the scroll', () => {
    expect(resolveFeedSource(['meili', 'meili', 'none'])).toBe('meili');
  });

  it('answers nothing when no page reported a backend', () => {
    expect(resolveFeedSource(['none'])).toBeUndefined();
    expect(resolveFeedSource([])).toBeUndefined();
  });

  // Turning the flag off mid-session routes later pages through the DB, which
  // returns a real cursor and real items. Those pages must ANSWER, or the notice
  // stays up over Postgres results — the failure the whole gate exists to stop.
  it('answers db when the flag went off mid-session and the DB took over', () => {
    expect(resolveFeedSource(['meili', 'meili', 'db', 'db'])).toBe('db');
  });
});

describe('buildFeedSnapshot', () => {
  const filters = { sort: 'Newest', period: 'Day', browsingLevel: 1 };

  it('answers with resolveFeedSource, not the raw last entry', () => {
    const snapshot = buildFeedSnapshot([{ source: 'meili' }, { items: [] }], filters, 1);

    expect(snapshot.source).toBe('meili');
    expect(snapshot.sources).toEqual(['meili', 'none']);
  });

  it('carries the filters that fetched these pages', () => {
    const snapshot = buildFeedSnapshot([{ source: 'meili' }], filters, 1);

    expect(snapshot).toMatchObject({
      sort: 'Newest',
      period: 'Day',
      pagesLoaded: 1,
      browsingLevel: 1,
    });
  });

  // Per-page fallback makes an alternating feed ordinary here, and the report has
  // to agree with itself: the last entry is what `source` was read from.
  it('records every page of a deep alternating scroll, ending where source did', () => {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      source: i % 2 === 0 ? 'meili' : 'db',
    }));

    const snapshot = buildFeedSnapshot(pages, filters, 1);

    expect(snapshot.sources).toHaveLength(40);
    expect(snapshot.sources[snapshot.sources.length - 1]).toBe('db');
    expect(snapshot.source).toBe('db');
  });
});
