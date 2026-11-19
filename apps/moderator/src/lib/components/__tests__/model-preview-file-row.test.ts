// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelPreviewFile } from '$lib/server/model-preview.service';

/**
 * A file row in the moderator's model preview, server-rendered. This config has no Svelte plugin, so
 * the component is compiled here with its UI imports pointed at stand-ins; `previewFileControl` is
 * the real one, so the row is tested with the decision it actually makes.
 */
const require = createRequire(import.meta.url);
const SVELTE = path.dirname(require.resolve('svelte/package.json'));
const pkg = JSON.parse(readFileSync(path.join(SVELTE, 'package.json'), 'utf8'));
const { compile } = await import(pathToFileURL(path.join(SVELTE, 'src/compiler/index.js')).href);

function serverEntry(spec: string): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e.default;
  return pathToFileURL(path.join(SVELTE, e)).href;
}

const STUBS: Record<string, string> = {
  Button: `<script>let { children, type = 'button', variant, size, ...rest } = $props();</script>
<button {type} {...rest}>{@render children?.()}</button>`,
  Badge: `<script>let { children, variant, ...rest } = $props();</script>
<span data-badge {...rest}>{@render children?.()}</span>`,
  IconDownload: `<script>let props = $props();</script><svg data-icon="download"></svg>`,
};
const IMPORTS: [RegExp, string][] = [
  [/import \{ Badge \} from '[^']+';/, "import Badge from './Badge.js';"],
  [/import \{ Button \} from '[^']+';/, "import Button from './Button.js';"],
  [/import \{ IconDownload \} from '[^']+';/, "import IconDownload from './IconDownload.js';"],
  [/import \{ bytes \} from '\$lib\/format';/, 'const bytes = (kb) => `${kb} KB`;'],
  [
    /import \{ previewFileControl \} from '\$lib\/model-preview-file';/,
    "import { previewFileControl } from './model-preview-file.js';",
  ],
  [/import type \{ ModelPreviewFile \} from '[^']+';/, ''],
];

const cache = path.resolve(import.meta.dirname, '../../../../node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, 'model-preview-file-row-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function emit(name: string, source: string) {
  const { js } = compile(source, { generate: 'server', filename: `${name}.svelte` });
  writeFileSync(
    path.join(work, `${name}.js`),
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${serverEntry(s)}'`
    )
  );
}

let Row: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const [name, source] of Object.entries(STUBS)) emit(name, source);
  const helper = readFileSync(
    path.resolve(import.meta.dirname, '../../model-preview-file.ts'),
    'utf8'
  );
  writeFileSync(
    path.join(work, 'model-preview-file.js'),
    ts.transpileModule(helper, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
  );
  let source = readFileSync(
    path.resolve(import.meta.dirname, '../ModelPreviewFileRow.svelte'),
    'utf8'
  );
  for (const [from, to] of IMPORTS) {
    expect(source).toMatch(from);
    source = source.replace(from, to);
  }
  emit('ModelPreviewFileRow', source);
  Row = (
    await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'ModelPreviewFileRow.js')).href)
  ).default;
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

const file = (over: Partial<ModelPreviewFile>): ModelPreviewFile => ({
  id: 1,
  name: 'data.zip',
  type: 'Training Data',
  sizeKB: 10,
  format: null,
  pickleScan: 'Success',
  virusScan: 'Success',
  visibility: 'Private',
  purged: false,
  ...over,
});

function show(f: ModelPreviewFile) {
  document.body.innerHTML = render(Row, {
    props: {
      file: f,
      versionId: 5,
      civitaiUrl: 'https://site.test',
      canViewTrainingData: true,
      onview: () => {},
    },
  }).body;
  return {
    badges: [...document.querySelectorAll('[data-badge]')].map((b) => b.textContent?.trim()),
    view: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'View'),
    download: !!document.querySelector('a[href*="/api/download/"]'),
  };
}

describe('a file row in the model preview', () => {
  it('says purged training data was removed, without its visibility or a View button', () => {
    expect(show(file({ purged: true }))).toEqual({
      badges: ['Training data removed (purged)'],
      view: false,
      download: false,
    });
  });

  it('keeps the visibility badge and View for live training data', () => {
    expect(show(file({}))).toEqual({ badges: ['Private'], view: true, download: false });
  });

  it('keeps a Danger scan on a purged row but drops "not scanned yet"', () => {
    expect(show(file({ purged: true, virusScan: 'Danger' })).badges).toEqual([
      'Training data removed (purged)',
      'Virus detected',
    ]);
    expect(show(file({ purged: true, pickleScan: 'Pending' })).badges).toEqual([
      'Training data removed (purged)',
    ]);
  });

  it('offers a download on a live model file', () => {
    expect(show(file({ type: 'Model', visibility: 'Public' }))).toEqual({
      badges: [],
      view: false,
      download: true,
    });
  });
});
