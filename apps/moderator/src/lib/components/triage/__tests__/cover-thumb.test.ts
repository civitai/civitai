// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as heldMedia from '$lib/held-media';
import * as edgeUrl from '$lib/media/edge-url';

// The compiled components are imported outside Vite, where `$lib` does not resolve.
(globalThis as Record<string, unknown>).__thumbLib = { heldMedia, edgeUrl };

/**
 * A triage row's thumbnail, mounted in the browser build with the real storage-fallback tile and
 * the CDN component stubbed to a plain <img>: a tile the CDN refuses is asked for from storage, and
 * a withheld image is drawn with no media at all.
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
const work = mkdtempSync(path.join(cache, 'cover-thumb-'));
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

function swap(source: string, imports: [RegExp, string][]) {
  for (const [from, to] of imports) {
    expect(source).toMatch(from);
    source = source.replace(from, to);
  }
  return source;
}

const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const HELD_MEDIA: [RegExp, string] = [
  /import \{[^}]*\} from '\$lib\/held-media';/,
  'const { probeRetractedRefusal, RETRACTED_REFUSED, retractedMediaUrl, WITHHELD_REFUSED, MEDIA_UNPROCESSED } = globalThis.__thumbLib.heldMedia;',
];

let Thumb: unknown;
let svelte: {
  mount: (c: unknown, o: { target: Element; props: unknown }) => unknown;
  unmount: (app: unknown) => void;
  flushSync: () => void;
};

beforeAll(async () => {
  emit('Edge', `<script>let { src } = $props();</script><img alt="" {src} />`);
  emit(
    'Icon',
    `<script>let props = $props();</script><svg aria-label={props['aria-label']}></svg>`
  );
  emit(
    'Cdn',
    swap(read('../../image-queue/CdnOrRetractedMedia.svelte'), [
      [/import EdgeMedia from '[^']+';/, "import EdgeMedia from './Edge.js';"],
      [
        /import \{ getInferredMediaType, type MediaType \} from '\$lib\/media\/edge-url';/,
        'const { getInferredMediaType } = globalThis.__thumbLib.edgeUrl;',
      ],
      HELD_MEDIA,
    ])
  );
  emit(
    'Thumb',
    swap(read('../CoverThumb.svelte'), [
      [
        /import \{ IconPhotoOff \} from '@tabler\/icons-svelte';/,
        "import IconPhotoOff from './Icon.js';",
      ],
      [/import CdnOrRetractedMedia from '[^']+';/, "import CdnOrRetractedMedia from './Cdn.js';"],
      HELD_MEDIA,
      [/import type \{ AppealCoverImage \} from '[^']+';/, ''],
    ])
  );
  Thumb = (await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'Thumb.js')).href))
    .default;
  svelte = await import(/* @vite-ignore */ clientEntry('svelte'));
});

const ID = 990000501;
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = '';
});

function mountThumb(image: object) {
  const target = document.createElement('div');
  document.body.append(target);
  const app = svelte.mount(Thumb, { target, props: { image } });
  svelte.flushSync();
  return { target, app };
}

describe('a triage row thumbnail', () => {
  it('asks storage for an image the CDN refuses', () => {
    const { target, app } = mountThumb({ id: ID, url: `key-${ID}`, nsfwLevel: 1 });
    expect(target.querySelector('img')?.getAttribute('src')).toBe(`key-${ID}`);
    target.querySelector('img')!.dispatchEvent(new Event('error'));
    svelte.flushSync();
    expect(target.querySelector('img')?.getAttribute('src')).toBe(heldMedia.retractedMediaUrl(ID));
    svelte.unmount(app);
  });

  it('draws a withheld image with no media and asks for nothing', () => {
    const { target, app } = mountThumb({ id: ID, url: '', nsfwLevel: 1, restricted: true });
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelector('svg')?.getAttribute('aria-label')).toBe(
      heldMedia.WITHHELD_REFUSED
    );
    expect(fetchMock).not.toHaveBeenCalled();
    svelte.unmount(app);
  });
});
