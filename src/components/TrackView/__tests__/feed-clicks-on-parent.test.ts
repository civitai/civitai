// @vitest-environment happy-dom
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { trackFeedClicks } from '~/components/TrackView/useTrackImpression';
import { __trackBufferTestHooks } from '~/components/TrackView/trackEventBuffer';
import { setFeedEventsCache, setFeedEventsEnabled } from '~/utils/feed-events';
import type { TrackBatchEvent } from '~/server/schema/track.schema';

vi.mock('next/router', () => ({
  default: { pathname: '/models', events: { on: () => undefined, off: () => undefined } },
}));
// The network is the boundary: rows are read off the bodies the shared buffer POSTs.
const fetchMock = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean }>>(() =>
  Promise.resolve({ ok: true })
);
vi.stubGlobal('fetch', fetchMock);

const clickRows = () => {
  __trackBufferTestHooks.flush();
  return fetchMock.mock.calls
    .flatMap(([, init]) => JSON.parse(init.body) as TrackBatchEvent[])
    .flatMap((e) => (e.kind === 'feed' && e.data.event === 'click' ? [e.data.entityId] : []));
};

// A carousel slide: the sentinel overlay beside the slide's link, under one positioned box.
function slide() {
  const box = document.createElement('div');
  box.innerHTML =
    '<span class="pointer-events-none"></span><a href="/models/7"><img alt=""></a><button type="button">menu</button>';
  document.body.appendChild(box);
  return { sentinel: box.querySelector('span')!, q: (s: string) => box.querySelector(s)! };
}
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

beforeEach(() => {
  fetchMock.mockClear();
  __trackBufferTestHooks.reset();
  const client = new QueryClient();
  setFeedEventsCache(client.getQueryCache());
  setFeedEventsEnabled(true);
  client.setQueryData([['model', 'getAll'], { input: {}, type: 'infinite' }], {
    pages: [{ items: [{ id: 7 }] }],
    pageParams: [0],
  });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('feed clicks for a card tracked by an overlay', () => {
  it("counts a link click beside the sentinel, on the sentinel's parent; not a button", () => {
    const { sentinel, q } = slide();
    trackFeedClicks(sentinel, [{ entityType: 'Model', entityId: 7 }], true);
    click(q('img'));
    click(q('button'));
    expect(clickRows()).toEqual([7]);
  });

  it('on the sentinel itself, the same click never arrives', () => {
    const { sentinel, q } = slide();
    trackFeedClicks(sentinel, [{ entityType: 'Model', entityId: 7 }]);
    click(q('img'));
    expect(clickRows()).toEqual([]);
  });

  // Without the flag every sentinel card (model-page carousel, post images, images-as-posts) loses
  // its click rows silently; rendering the sentinel needs the flags provider this suite cannot mount.
  it('ImpressionSentinel asks for its clicks on the parent', () => {
    const source = readFileSync(path.resolve(__dirname, '../ImpressionSentinel.tsx'), 'utf8');
    expect(source).toMatch(/useTrackImpression<\w+>\(impressions, \{ clicksOnParent: true \}\);/);
  });
});
