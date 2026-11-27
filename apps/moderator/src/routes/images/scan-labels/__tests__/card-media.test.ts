// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The Scan Labels card's media, mounted in the browser build: media the route cannot serve says so,
 * where a broken <img> used to show only its alt text, which read as a status.
 */
const require = createRequire(import.meta.url);
const SVELTE = path.dirname(require.resolve('svelte/package.json'));
const pkg = JSON.parse(readFileSync(path.join(SVELTE, 'package.json'), 'utf8'));
const { compile } = await import(pathToFileURL(path.join(SVELTE, 'src/compiler/index.js')).href);

function entry(spec: string, condition: 'browser' | 'default'): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e[condition] ?? e.default;
  return pathToFileURL(path.join(SVELTE, e)).href;
}
const clientEntry = (spec: string) => entry(spec, 'browser');
const serverEntry = (spec: string) => entry(spec, 'default');

// Inside src, not node_modules: Vitest transforms only files outside node_modules.
const work = mkdtempSync(path.join(import.meta.dirname, '.card-media-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Svelte = {
  mount: (c: unknown, o: { target: Element; props: unknown }) => unknown;
  unmount: (app: unknown) => void;
  flushSync: () => void;
};
let svelte: Svelte;
let CardMedia: unknown;
let CardMediaServer: unknown;

async function load(generate: 'client' | 'server', resolve: (spec: string) => string) {
  const source = readFileSync(path.join(import.meta.dirname, '../CardMedia.svelte'), 'utf8');
  const { js } = compile(source, { generate, filename: 'CardMedia.svelte' });
  const file = path.join(work, `CardMedia.${generate}.js`);
  writeFileSync(
    file,
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${resolve(s)}'`
    )
  );
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)).default;
}

beforeAll(async () => {
  CardMedia = await load('client', clientEntry);
  CardMediaServer = await load('server', serverEntry);
  svelte = await import(/* @vite-ignore */ clientEntry('svelte'));
});

beforeEach(() => {
  document.body.innerHTML = '';
});

function mount(type: string) {
  const target = document.createElement('div');
  document.body.append(target);
  const app = svelte.mount(CardMedia, {
    target,
    props: { type, mediaSrc: '/images/scan-labels/media/token', width: 10, height: 10 },
  });
  svelte.flushSync();
  return { target, app };
}

const status = (target: Element) => target.querySelector('[role="status"]')?.textContent?.trim();

describe('Scan Labels card media', () => {
  it('says an image failed to load when the route refuses it, and never shows a status as alt', () => {
    const { target, app } = mount('image');
    const img = target.querySelector('img');
    expect(img?.getAttribute('alt')).not.toMatch(/review/i);
    expect(status(target)).toBeUndefined();
    img?.dispatchEvent(new Event('error'));
    svelte.flushSync();
    expect(status(target)).toBe('Image failed to load');
    expect(target.querySelector('img')).toBeNull();
    svelte.unmount(app);
  });

  // The first card arrives server-rendered, and the route can refuse its media before the page
  // hydrates. Svelte replays an <img> error only from an element carrying its own handler, which
  // the server render marks with an inline capture.
  it('server-renders an image that keeps an error from before hydration', async () => {
    const { render } = await import(/* @vite-ignore */ serverEntry('svelte/server'));
    const { body } = render(CardMediaServer, {
      props: { type: 'image', mediaSrc: '/m', width: 10, height: 10 },
    });
    const img = new DOMParser().parseFromString(body, 'text/html').querySelector('img');
    expect(img?.getAttribute('onerror')).toBe('this.__e=event');
  });

  /** Mounts a video whose `networkState` reads `before` until the next task, then `after`: a
   *  browser's NETWORK_NO_SOURCE on a new <video> lasts until source selection starts. `later` is
   *  read past the component's wait. */
  async function videoStatusAfterATask(before: number, after: number) {
    const proto = HTMLMediaElement.prototype;
    const own = Object.getOwnPropertyDescriptor(proto, 'networkState');
    let state = before;
    Object.defineProperty(proto, 'networkState', { configurable: true, get: () => state });
    try {
      const { target, app } = mount('video');
      const atMount = status(target);
      setTimeout(() => (state = after));
      await new Promise((r) => setTimeout(r, 400));
      svelte.flushSync();
      const later = status(target);
      svelte.unmount(app);
      return { atMount, later };
    } finally {
      if (own) Object.defineProperty(proto, 'networkState', own);
    }
  }

  // Every card after the first mounts client-side; reading the new video's state as failure would
  // fail them all.
  it('does not take a new video’s NETWORK_NO_SOURCE for a failure', async () => {
    const { NETWORK_NO_SOURCE, NETWORK_LOADING } = HTMLMediaElement;
    expect(await videoStatusAfterATask(NETWORK_NO_SOURCE, NETWORK_LOADING)).toEqual({
      atMount: 'Loading video...',
      later: 'Loading video...',
    });
  });

  // The first card is server-rendered: a video whose sources were refused before hydration fired
  // errors no one heard, and stays NETWORK_NO_SOURCE.
  it('says a video failed to load when it still has no source a task after mounting', async () => {
    const { NETWORK_NO_SOURCE } = HTMLMediaElement;
    expect(await videoStatusAfterATask(NETWORK_NO_SOURCE, NETWORK_NO_SOURCE)).toEqual({
      atMount: 'Loading video...',
      later: 'Video failed to load',
    });
  });

  it('shows a video that already has a frame when it mounts as ready', () => {
    const proto = HTMLMediaElement.prototype;
    const own = Object.getOwnPropertyDescriptor(proto, 'readyState');
    Object.defineProperty(proto, 'readyState', {
      configurable: true,
      get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
    });
    try {
      const { target, app } = mount('video');
      expect(status(target)).toBeUndefined();
      svelte.unmount(app);
    } finally {
      if (own) Object.defineProperty(proto, 'readyState', own);
    }
  });

  it('says a video failed to load only when its last source fails', () => {
    const { target, app } = mount('video');
    const [webm, mp4] = target.querySelectorAll('source');
    webm.dispatchEvent(new Event('error'));
    svelte.flushSync();
    expect(status(target)).toBe('Loading video...');
    mp4.dispatchEvent(new Event('error'));
    svelte.flushSync();
    expect(status(target)).toBe('Video failed to load');
    svelte.unmount(app);
  });
});
