import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { ModerationImageModel } from '~/server/services/image.service';

// The public CDN copy, as an element the test can load or play.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: (props: { type?: string; html5Controls?: boolean; onClick?: () => void }) =>
    props.type === 'video' ? (
      <video data-testid="cdn-media" controls={props.html5Controls} onClick={props.onClick} />
    ) : (
      <img data-testid="cdn-media" alt="" onClick={props.onClick} />
    ),
}));

import { CsamHeldMedia } from '~/components/Csam/CsamHeldMedia';
import { CsamImageCard } from '~/components/Csam/CsamImageSelection';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { useCsamImageSelectStore } from '~/components/Csam/useCsamImageSelect.store';

const fetchMock = vi.fn();
const image = {
  id: 41,
  userId: 20,
  url: 'k',
  name: 'x',
  type: 'image',
  width: 100,
  height: 100,
} as unknown as ModerationImageModel;
const video = { ...image, type: 'video' } as unknown as ModerationImageModel;

const shownPosts = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === '/api/mod/held-media/shown')
    .map(([, init]) => JSON.parse(init.body));

/** A held file: the route's own <img> or <video> stays on screen (the probe never answers). Shown
 *  rows are answered `shownStatus`. */
const held = (shownStatus = 204) =>
  fetchMock.mockImplementation((url: string) =>
    url === '/api/mod/held-media/shown'
      ? Promise.resolve(new Response(null, { status: shownStatus }))
      : new Promise(() => undefined)
  );
/** Not held: the probe says so, and the CDN copy replaces the route's. */
const notHeld = () =>
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith('?probe=1')
      ? new Response(null, { status: 404, headers: { 'x-held-media': 'not-held' } })
      : new Response(null, { status: 204 })
  );

function loadImage(img: HTMLImageElement, naturalWidth = 100) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: naturalWidth });
  img.dispatchEvent(new Event('load'));
}

/** Plays `ranges` of a video `duration` seconds long, as the element reports them. */
function play(el: HTMLVideoElement, duration: number, ranges: [number, number][]) {
  Object.defineProperty(el, 'duration', { configurable: true, value: duration });
  Object.defineProperty(el, 'played', {
    configurable: true,
    value: {
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    },
  });
  el.dispatchEvent(new Event('timeupdate'));
}

const renderCard = (data: ModerationImageModel) =>
  renderWithProviders(
    <IntersectionObserverProvider>
      <CsamImageCard data={data} height={100} />
    </IntersectionObserverProvider>
  );

const media = async (selector: string) => {
  await expect.poll(() => document.querySelector(selector)).not.toBeNull();
  return document.querySelector(selector) as HTMLElement;
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useCsamImageSelectStore.setState({ selected: {}, seeded: {}, shownRows: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('CsamHeldMedia onShown', () => {
  test('reports the original once the held image has loaded', async () => {
    held();
    const onShown = vi.fn();
    await renderWithProviders(
      <CsamHeldMedia image={image} onClick={() => undefined} onShown={onShown} />
    );
    const img = (await media('img[src="/api/mod/held-media/41"]')) as HTMLImageElement;
    expect(onShown).not.toHaveBeenCalled();

    loadImage(img);

    expect(onShown).toHaveBeenCalledWith('original');
  });

  test('reports the CDN rendition once the CDN copy has loaded', async () => {
    notHeld();
    const onShown = vi.fn();
    await renderWithProviders(
      <CsamHeldMedia image={image} onClick={() => undefined} onShown={onShown} />
    );
    const img = (await media('[data-testid="cdn-media"]')) as HTMLImageElement;

    loadImage(img);

    expect(onShown).toHaveBeenCalledWith('cdn-450');
  });

  test('reports nothing for a load with no pixels', async () => {
    held();
    const onShown = vi.fn();
    await renderWithProviders(
      <CsamHeldMedia image={image} onClick={() => undefined} onShown={onShown} />
    );
    loadImage((await media('img')) as HTMLImageElement, 0);
    expect(onShown).not.toHaveBeenCalled();
  });

  test.each([
    ['a tenth of a second', 100, [[0, 0.1]]],
    [
      'a seek to the end',
      100,
      [
        [0, 1],
        [99, 100],
      ],
    ],
    ['an unknown duration', NaN, [[0, 100]]],
    ['an endless stream', Infinity, [[0, 100]]],
  ] as [string, number, [number, number][]][])(
    'reports nothing for a video after %s',
    async (_, duration, ranges) => {
      held();
      const onShown = vi.fn();
      await renderWithProviders(
        <CsamHeldMedia image={video} onClick={() => undefined} onShown={onShown} />
      );
      const el = (await media('video')) as HTMLVideoElement;
      el.dispatchEvent(new Event('loadedmetadata'));
      el.dispatchEvent(new Event('playing'));
      play(el, duration, ranges);
      expect(onShown).not.toHaveBeenCalled();
    }
  );

  test('reports a video once 95% has played, across pauses', async () => {
    held();
    const onShown = vi.fn();
    await renderWithProviders(
      <CsamHeldMedia image={video} onClick={() => undefined} onShown={onShown} />
    );
    const el = (await media('video')) as HTMLVideoElement;
    expect(el.hasAttribute('controls')).toBe(true);

    play(el, 100, [[0, 50]]);
    expect(onShown).not.toHaveBeenCalled();
    play(el, 100, [[0, 94]]);
    expect(onShown).not.toHaveBeenCalled();
    play(el, 100, [
      [0, 50],
      [50, 96],
    ]);
    expect(onShown).toHaveBeenCalledWith('original');
    play(el, 100, [[0, 100]]);

    expect(onShown.mock.calls).toEqual([['original']]);
  });

  test('reports the CDN rendition of a video once 95% has played, with controls to play it', async () => {
    notHeld();
    const onShown = vi.fn();
    await renderWithProviders(
      <CsamHeldMedia image={video} onClick={() => undefined} onShown={onShown} />
    );
    const el = (await media('video[data-testid="cdn-media"]')) as HTMLVideoElement;
    expect(el.hasAttribute('controls')).toBe(true);

    play(el, 100, [[0, 96]]);

    expect(onShown.mock.calls).toEqual([['cdn-450']]);
  });
});

describe('selecting on the report page', () => {
  test('selecting before the image loaded records nothing, then or later', async () => {
    held();
    await renderCard(image);
    const img = (await media('img[src="/api/mod/held-media/41"]')) as HTMLImageElement;

    img.click();
    loadImage(img);

    expect(useCsamImageSelectStore.getState().selected[20]?.[41]).toBe(true);
    expect(shownPosts()).toEqual([]);
  });

  test('selecting after the image loaded records it, and deselecting records nothing', async () => {
    held();
    await renderCard(image);
    const img = (await media('img[src="/api/mod/held-media/41"]')) as HTMLImageElement;
    loadImage(img);

    img.click();
    img.click();

    expect(shownPosts()).toEqual([
      { imageId: 41, userId: 20, action: 'select', rendition: 'original' },
    ]);
  });

  test('records the CDN rendition when the CDN copy was on screen', async () => {
    notHeld();
    await renderCard(image);
    const img = (await media('[data-testid="cdn-media"]')) as HTMLImageElement;
    loadImage(img);

    await page.getByRole('checkbox').click();

    expect(shownPosts()).toEqual([
      { imageId: 41, userId: 20, action: 'select', rendition: 'cdn-450' },
    ]);
  });

  test('an error tile records nothing when clicked', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 502 }));
    await renderCard(image);
    await page.getByText('Could not load this file.', { exact: false }).click();
    expect(shownPosts()).toEqual([]);
  });

  test('a preselected image records nothing', async () => {
    held();
    useCsamImageSelectStore.getState().seedSelected(20, 41);
    await renderCard(image);
    loadImage((await media('img')) as HTMLImageElement);
    expect(shownPosts()).toEqual([]);
  });

  const CUE = 'Open full view to confirm viewed';
  const cueShown = () => !!document.body.textContent?.includes(CUE);
  const rowFor41 = () => useCsamImageSelectStore.getState().shownRows['20:41'];
  /** Opens the tile's full view and loads the image in it. */
  async function openFullView(from: 'cue' | 'icon') {
    await page.getByRole('button', { name: from === 'cue' ? CUE : 'View full size' }).click();
    await expect
      .poll(() => document.querySelectorAll('img[src="/api/mod/held-media/41"]').length)
      .toBe(2);
    loadImage(document.querySelectorAll<HTMLImageElement>('img[src="/api/mod/held-media/41"]')[1]);
  }

  test('a preselected image asks for its full view until its open is recorded', async () => {
    held();
    useCsamImageSelectStore.getState().seedSelected(20, 41);
    await renderCard(image);
    await expect.element(page.getByRole('button', { name: CUE })).toBeInTheDocument();

    await openFullView('cue');

    expect(shownPosts()).toEqual([
      { imageId: 41, userId: 20, action: 'open', rendition: 'original' },
    ]);
    await expect.poll(rowFor41).toBe('recorded');
    await page.getByRole('button', { name: 'Close' }).click();
    expect(cueShown()).toBe(false);
  });

  test('keeps asking when the open is refused', async () => {
    held(403);
    useCsamImageSelectStore.getState().seedSelected(20, 41);
    await renderCard(image);

    await openFullView('cue');

    await expect.poll(rowFor41).toBe('refused');
    await page.getByRole('button', { name: 'Close' }).click();
    expect(cueShown()).toBe(true);
  });

  test('asks for the full view of an image whose selection was refused', async () => {
    held(403);
    await renderCard(image);
    loadImage((await media('img')) as HTMLImageElement);
    expect(cueShown()).toBe(false);

    await page.getByRole('checkbox').click();

    await expect.poll(rowFor41).toBe('refused');
    expect(cueShown()).toBe(true);
  });

  test('a recorded open still counts once the tile is remounted', async () => {
    held();
    useCsamImageSelectStore.getState().seedSelected(20, 41);
    const first = await renderCard(image);
    await openFullView('cue');
    await expect.poll(rowFor41).toBe('recorded');
    await page.getByRole('button', { name: 'Close' }).click();

    // A new key mounts a new card, as stepping away and back does.
    await first.rerender(
      <IntersectionObserverProvider>
        <CsamImageCard key="again" data={image} height={100} />
      </IntersectionObserverProvider>
    );
    await expect
      .poll(() => document.querySelector('img[src="/api/mod/held-media/41"]'))
      .not.toBeNull();

    expect(cueShown()).toBe(false);
  });

  test('a preselected image the moderator deselected shows no cue', async () => {
    held();
    useCsamImageSelectStore.getState().seedSelected(20, 41);
    await renderCard(image);

    await page.getByRole('checkbox').click();

    expect(useCsamImageSelectStore.getState().selected[20]?.[41]).toBeUndefined();
    expect(cueShown()).toBe(false);
  });

  test('an image the moderator selected shows no cue', async () => {
    held();
    await renderCard(image);
    loadImage((await media('img')) as HTMLImageElement);
    await page.getByRole('checkbox').click();

    await expect.poll(rowFor41).toBe('recorded');
    expect(cueShown()).toBe(false);
  });

  test('clicking the CDN copy of an image selects it and records it', async () => {
    notHeld();
    await renderCard(image);
    const img = (await media('[data-testid="cdn-media"]')) as HTMLImageElement;
    loadImage(img);

    img.click();

    expect(useCsamImageSelectStore.getState().selected[20]?.[41]).toBe(true);
    expect(shownPosts()).toEqual([
      { imageId: 41, userId: 20, action: 'select', rendition: 'cdn-450' },
    ]);
  });

  test.each([
    ['held', held, 'video'],
    ['CDN', notHeld, 'video[data-testid="cdn-media"]'],
  ] as const)(
    'clicking a watched %s video (its controls) neither selects nor records',
    async (_, answer, selector) => {
      answer();
      await renderCard(video);
      const el = (await media(selector)) as HTMLVideoElement;
      play(el, 100, [[0, 100]]);

      el.click();

      expect(useCsamImageSelectStore.getState().selected[20]?.[41]).toBeUndefined();
      expect(shownPosts()).toEqual([]);
    }
  );

  test('a video selected before 95% played records nothing', async () => {
    held();
    await renderCard(video);
    const el = (await media('video')) as HTMLVideoElement;
    el.dispatchEvent(new Event('playing'));
    play(el, 100, [[0, 10]]);

    await page.getByRole('checkbox').click();

    expect(shownPosts()).toEqual([]);
  });
});

describe('the full view', () => {
  test('records the open once the image in it has loaded', async () => {
    held();
    await renderCard(image);
    await page.getByRole('button', { name: 'View full size' }).click();
    await expect
      .poll(() => document.querySelectorAll('img[src="/api/mod/held-media/41"]').length)
      .toBe(2);
    expect(shownPosts()).toEqual([]);

    loadImage(document.querySelectorAll<HTMLImageElement>('img[src="/api/mod/held-media/41"]')[1]);

    expect(shownPosts()).toEqual([
      { imageId: 41, userId: 20, action: 'open', rendition: 'original' },
    ]);
    expect(useCsamImageSelectStore.getState().selected[20]?.[41]).toBeUndefined();
  });

  test('opening and closing before it loads records nothing', async () => {
    held();
    await renderCard(image);
    await page.getByRole('button', { name: 'View full size' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    expect(shownPosts()).toEqual([]);
  });
});
