// @vitest-environment jsdom
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { retractedMediaUrl, WITHHELD_REFUSED } from '$lib/held-media';

/**
 * The Model Flags image tiles a moderator reads a model by: the detail pane's preview and a shared
 * file's two covers. A taken-down model's images are refused by the public CDN, so a tile the CDN
 * refuses is asked for from storage (`/api/retracted-media`), as Bulk Image Manager's tiles are; a
 * withheld image is drawn with no media and asks for nothing. Mounted in the browser build with the
 * real storage-fallback tile and the CDN component stubbed to a plain <img>.
 */
const require = createRequire(import.meta.url);
const SVELTE = path.dirname(require.resolve('svelte/package.json'));
const pkg = JSON.parse(readFileSync(path.join(SVELTE, 'package.json'), 'utf8'));
const { compile } = await import(pathToFileURL(path.join(SVELTE, 'src/compiler/index.js')).href);
const LIB = path.resolve(import.meta.dirname, '../..');

function clientEntry(spec: string): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e.browser ?? e.default;
  return pathToFileURL(path.join(SVELTE, e)).href;
}

// Inside src, not node_modules: Vitest transforms only files outside node_modules.
const work = mkdtempSync(path.join(import.meta.dirname, '.model-flag-media-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The component's `$lib` TypeScript imports pointed at the files, and its Svelte children at stubs. */
function emit(name: string, source: string, children: Record<string, string> = {}) {
  for (const [component, stub] of Object.entries(children)) {
    const from = new RegExp(`import (\\{ )?${component}( \\})? from '[^']+';`);
    expect(source).toMatch(from);
    source = source.replace(from, `import ${component} from './${stub}.js';`);
  }
  source = source
    .replace(/import \{ browser \} from '\$app\/environment';/, 'const browser = true;')
    .replace(/^\s*import type [^;]+;$/gm, '')
    .replace(/from '\$lib\/([^']+)'/g, (whole: string, rel: string) => {
      const file = path.join(LIB, `${rel}.ts`);
      return existsSync(file) ? `from '${pathToFileURL(file).href}'` : whole;
    });
  expect(source).not.toMatch(/from '\$lib\//);
  const { js } = compile(source, { generate: 'client', filename: `${name}.svelte` });
  writeFileSync(
    path.join(work, `${name}.js`),
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${clientEntry(s)}'`
    )
  );
}

const read = (rel: string) => readFileSync(path.join(LIB, rel), 'utf8');
const STUB = `<script>let { children, ...rest } = $props();</script><span>{@render children?.()}</span>`;

type Svelte = {
  mount: (c: unknown, o: { target: Element; props: unknown }) => unknown;
  unmount: (app: unknown) => void;
  flushSync: () => void;
  tick: () => Promise<void>;
};
let svelte: Svelte;
let Preview: unknown;
let SharedFile: unknown;

beforeAll(async () => {
  emit('Edge', `<script>let { src } = $props();</script><img alt="" {src} />`);
  emit(
    'Icon',
    `<script>let props = $props();</script><svg aria-label={props['aria-label']}></svg>`
  );
  emit('Stub', STUB);
  emit('Cdn', read('components/image-queue/CdnOrRetractedMedia.svelte'), { EdgeMedia: 'Edge' });
  emit('Preview', read('components/ModelPreview.svelte'), {
    Badge: 'Stub',
    CdnOrRetractedMedia: 'Cdn',
    Lightbox: 'Stub',
    IconPhotoOff: 'Icon',
    TrainingDataSheet: 'Stub',
    ModelPreviewFileRow: 'Stub',
  });
  emit(
    'SharedFile',
    read('components/minor-flags/SharedFileCard.svelte').replace(
      /import \{ IconFileCheck, IconPhotoOff \} from '@tabler\/icons-svelte';/,
      "import IconFileCheck from './Icon.js'; import IconPhotoOff from './Icon.js';"
    ),
    {
      CdnOrRetractedMedia: 'Cdn',
      MatureRestrictedBadge: 'Stub',
      MetaChip: 'Stub',
      TriageCard: 'Stub',
    }
  );
  const load = async (name: string) =>
    (await import(/* @vite-ignore */ pathToFileURL(path.join(work, `${name}.js`)).href)).default;
  Preview = await load('Preview');
  SharedFile = await load('SharedFile');
  svelte = await import(/* @vite-ignore */ clientEntry('svelte'));
});

const OPEN = 990000601;
const WITHHELD = 990000602;
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  document.body.innerHTML = '';
});

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

async function mount(component: unknown, props: object) {
  const target = document.createElement('div');
  document.body.append(target);
  const app = svelte.mount(component, { target, props });
  // The component's own fetch, then the render it awaits.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    svelte.flushSync();
  }
  return { target, app };
}

const srcs = (target: Element) =>
  [...target.querySelectorAll('img')].map((img) => img.getAttribute('src'));

/** The CDN refuses every tile it drew, as it does every image of a taken-down model. */
function cdnRefuses(target: Element) {
  for (const img of target.querySelectorAll('img')) img.dispatchEvent(new Event('error'));
  svelte.flushSync();
}

const retractedRequests = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/retracted-media'));

describe('the Model Flags detail preview', () => {
  const image = {
    nsfwLevel: 1,
    type: 'image',
    blocked: false,
    minor: true,
    acceptableMinor: false,
  };
  const preview = (images: object[]) => ({
    id: 7,
    name: 'Model',
    type: 'LORA',
    userId: 1,
    username: 'owner',
    userBanned: false,
    createdAt: '2026-11-01T00:00:00Z',
    description: null,
    versions: [],
    tags: [],
    images,
    moreImages: false,
    otherReports: { total: 0, byStatus: {} },
  });
  const props = {
    modelId: 7,
    reportId: null,
    civitaiUrl: 'https://civitai.test',
    canViewTrainingData: false,
  };

  it('asks storage for a minor-flagged image the CDN refuses', async () => {
    fetchMock.mockImplementation(() => json(preview([{ ...image, id: OPEN, url: `key-${OPEN}` }])));
    const { target, app } = await mount(Preview, props);
    expect(srcs(target)).toEqual([`key-${OPEN}`]);
    cdnRefuses(target);
    expect(srcs(target)).toEqual([retractedMediaUrl(OPEN)]);
    svelte.unmount(app);
  });

  it('draws a withheld image with no media and never asks storage for it', async () => {
    fetchMock.mockImplementation(() =>
      json(preview([{ ...image, id: WITHHELD, url: '', minor: false, restricted: true }]))
    );
    const { target, app } = await mount(Preview, props);
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelector(`svg[aria-label="${WITHHELD_REFUSED}"]`)).not.toBeNull();
    expect(retractedRequests()).toEqual([]);
    svelte.unmount(app);
  });
});

describe('a shared file card', () => {
  const detail = (over: object) => ({
    modelCoverId: OPEN,
    modelCoverUrl: `key-${OPEN}`,
    modelCoverType: 'image',
    modelCoverRestricted: false,
    minorModelCoverId: WITHHELD,
    minorModelCoverUrl: null,
    minorModelCoverType: null,
    minorModelCoverRestricted: null,
    minorModelCoverWithheld: true,
    minorModelId: 8,
    minorModelName: 'Seed',
    minorModelVersionId: null,
    minorModelStatus: 'Published',
    minorModelUnpublishReason: null,
    minorModelUnpublishedAt: null,
    minorFlaggedAt: null,
    minorFlaggedBy: null,
    modelCreatedAt: null,
    ...over,
  });
  const props = {
    row: {
      modelId: 7,
      modelName: 'Model',
      userId: 1,
      username: 'owner',
      minorModelId: 8,
      hash: 'abc',
    },
    civitaiUrl: 'https://civitai.test',
    status: { label: 'under review', tone: 'blue' },
  };

  it('asks storage for a cover the CDN refuses, and draws a withheld cover with no media', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).startsWith('/api/retracted-media')
        ? json({})
        : json({ detail: detail({}), match: null })
    );
    const { target, app } = await mount(SharedFile, props);
    expect(srcs(target)).toEqual([`key-${OPEN}`]);
    expect(target.querySelector(`svg[aria-label="${WITHHELD_REFUSED}"]`)).not.toBeNull();
    cdnRefuses(target);
    expect(srcs(target)).toEqual([retractedMediaUrl(OPEN)]);
    expect(retractedRequests()).toEqual([]);
    svelte.unmount(app);
  });
});
