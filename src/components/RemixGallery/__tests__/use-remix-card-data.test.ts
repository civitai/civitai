// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { RemixCardData } from '~/components/RemixGallery/use-remix-card-data';
import type { RemixGalleryCardSummary } from '~/server/services/remix-gallery.service';

/**
 * Whether a feed card wears the remix frame and opens a strip. A host with stories started from it
 * and no remixes yet has to, or its stories are listed nowhere in the feed.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ summary: null as RemixGalleryCardSummary | null }));
vi.mock('~/components/RemixGallery/RemixGalleryBatchProvider', () => ({
  useRemixGalleryBatch: () => mocks.summary,
}));

const { useRemixCardData } = await import('~/components/RemixGallery/use-remix-card-data');

function read(summary: RemixGalleryCardSummary | null) {
  mocks.summary = summary;
  let result: RemixCardData | undefined;
  const Probe = () => {
    result = useRemixCardData(1);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  return result!;
}

const story = { storylineId: 3, title: 't', username: 'u', previews: [] };

describe('useRemixCardData', () => {
  it('counts a host with stories and no remixes as having something to show', () => {
    expect(
      read({ count: 0, entries: [], storylines: { count: 1, entries: [story] } })
    ).toMatchObject({ count: 0, any: true, storylines: { count: 1 } });
  });

  it.each([
    ['no summary (no provider)', null],
    ['an empty summary', { count: 0, entries: [] }],
    ['no stories asked for', { count: 0, entries: [], storylines: undefined }],
  ])('has nothing to show with %s', (_name, summary) => {
    expect(read(summary as RemixGalleryCardSummary | null)).toMatchObject({
      any: false,
      storylines: { count: 0, entries: [] },
    });
  });

  it('counts remixes alone as before', () => {
    expect(read({ count: 2, entries: [] })).toMatchObject({ count: 2, any: true });
  });
});
