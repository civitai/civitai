// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as heldMedia from '$lib/held-media';
import * as edgeUrl from '$lib/media/edge-url';

// The compiled tile is imported outside Vite, where `$lib` does not resolve.
(globalThis as Record<string, unknown>).__tileLib = { heldMedia, edgeUrl };

/**
 * A tile whose CDN load fails, mounted in the browser build with the CDN component stubbed to a
 * plain <img>: an unprocessed upload says so without asking storage, and any other tile falls back
 * to storage and shows the route's reason when that fails too.
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

const cache = path.resolve(import.meta.dirname, '../../../../../../../node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, 'cdn-or-retracted-media-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function emit(name: string, source: string) {
  const { js } = compile(source, { generate: 'client', filename: `${name}.svelte` });
  writeFileSync(
    path.join(work, `${name}.js`),
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${clientEntry(s)}'`
    )
  );
}

const IMPORTS: [RegExp, string][] = [
  [/import EdgeMedia from '[^']+';/, "import EdgeMedia from './Edge.js';"],
  [
    /import \{ getInferredMediaType, type MediaType \} from '\$lib\/media\/edge-url';/,
    'const { getInferredMediaType } = globalThis.__tileLib.edgeUrl;',
  ],
  [
    /import \{[^}]*\} from '\$lib\/held-media';/,
    'const { MEDIA_UNPROCESSED, probeRetractedRefusal, RETRACTED_REFUSED, retractedMediaUrl } = globalThis.__tileLib.heldMedia;',
  ],
];

let Tile: unknown;
let svelte: {
  mount: (c: unknown, o: { target: Element; props: unknown }) => unknown;
  unmount: (app: unknown) => void;
  flushSync: () => void;
};

beforeAll(async () => {
  emit('Edge', `<script>let { src } = $props();</script><img alt="" {src} />`);
  let tile = readFileSync(
    path.resolve(import.meta.dirname, '../CdnOrRetractedMedia.svelte'),
    'utf8'
  );
  for (const [from, to] of IMPORTS) {
    expect(tile).toMatch(from);
    tile = tile.replace(from, to);
  }
  emit('Tile', tile);
  Tile = (await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'Tile.js')).href)).default;
  svelte = await import(/* @vite-ignore */ clientEntry('svelte'));
});

const ID = 990000401;
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = '';
});

function mountTile(unprocessed: boolean) {
  const target = document.createElement('div');
  document.body.append(target);
  const app = svelte.mount(Tile, {
    target,
    props: { item: { id: ID, url: `key-${ID}`, type: 'image' }, unprocessed },
  });
  svelte.flushSync();
  return { target, app };
}

const failImage = (target: Element) => {
  target.querySelector('img')!.dispatchEvent(new Event('error'));
  svelte.flushSync();
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a tile the CDN cannot serve', () => {
  it('says an unprocessed upload did not process, and asks storage for nothing', async () => {
    const { target, app } = mountTile(true);
    failImage(target);
    await settle();
    expect(target.querySelector('img')).toBeNull();
    expect(target.textContent).toContain(heldMedia.MEDIA_UNPROCESSED);
    expect(target.textContent).not.toContain(heldMedia.RETRACTED_REFUSED);
    expect(fetchMock).not.toHaveBeenCalled();
    svelte.unmount(app);
  });

  it('falls back to storage otherwise, and says the file is unavailable when the route does', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: heldMedia.RETRACTED_UNAVAILABLE }), { status: 404 })
    );
    const { target, app } = mountTile(false);
    failImage(target);
    expect(target.querySelector('img')?.getAttribute('src')).toBe(heldMedia.retractedMediaUrl(ID));
    failImage(target);
    await settle();
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(`${heldMedia.retractedMediaUrl(ID)}?probe=1`);
    expect(target.textContent).toContain(heldMedia.RETRACTED_UNAVAILABLE);
    svelte.unmount(app);
  });

  it('keeps the generic line when the route refuses without saying the file is gone', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not available here.' }), { status: 404 })
    );
    const { target, app } = mountTile(false);
    failImage(target);
    failImage(target);
    await settle();
    await settle();
    expect(target.textContent).toContain(heldMedia.RETRACTED_REFUSED);
    svelte.unmount(app);
  });
});
