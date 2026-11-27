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

function clientEntry(spec: string): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e.browser ?? e.default;
  return pathToFileURL(path.join(SVELTE, e)).href;
}

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

beforeAll(async () => {
  const source = readFileSync(path.join(import.meta.dirname, '../CardMedia.svelte'), 'utf8');
  const { js } = compile(source, { generate: 'client', filename: 'CardMedia.svelte' });
  const file = path.join(work, 'CardMedia.js');
  writeFileSync(
    file,
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${clientEntry(s)}'`
    )
  );
  CardMedia = (await import(/* @vite-ignore */ pathToFileURL(file).href)).default;
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
