// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOOT_LEAD_NOTE } from '$lib/minor-flags/moot-lead';

/**
 * The lock-review appeal's Needs review notice, server-rendered. This config has no Svelte plugin, so
 * the real LockReviewDetail is compiled here with its child components stubbed; the frame draws only
 * the `info` area.
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

const SRC = path.resolve(import.meta.dirname, '../../../../..');
const work = mkdtempSync(path.join(import.meta.dirname, '.ssr-'));
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

const stubImports = (source: string) =>
  source
    .replace(/import \{ enhance \} from '\$app\/forms';/, 'const enhance = () => ({});')
    .replace(/import \{ modelFlagDetail \} from '[^']+';/, 'const modelFlagDetail = () => null;')
    .replace(
      /import \{[^}]+\} from '\$lib\/triage\/reason-picker\.svelte';/,
      `const reasonPicker = { open: null };
const closeReasonPickerBeyond = () => {};
const noteReasonChosen = () => {};
const resetReasonPicker = () => {};
const submitAwaitingNote = () => false;`
    )
    .replace(
      /import \{ [\w, ]+ \} from '@tabler\/icons-svelte[^']*';/g,
      'const IconAlertTriangle = () => {};'
    )
    .replace(
      /import ModelFlagDetailFrame from '[^']+';/,
      "import ModelFlagDetailFrame from './Frame.js';"
    )
    .replace(/import (\w+) from '[^']+\.svelte';/g, "import $1 from './Empty.js';");

let Detail: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  emit('Empty', '');
  emit('Frame', `<script>const props = $props();</script>{@render props.info?.()}`);
  emit(
    'Detail',
    stubImports(
      readFileSync(path.join(SRC, 'routes/models/flags/appeals/LockReviewDetail.svelte'), 'utf8')
    )
  );
  Detail = (await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'Detail.js')).href))
    .default;
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

const draw = (row: Record<string, unknown>) =>
  render(Detail, {
    props: {
      row: {
        modelId: 1,
        appealId: 2,
        minor: true,
        poi: false,
        lockReview: ['nsfw'],
        lockedProperties: ['nsfw'],
        alsoInNeedsReview: true,
        needsReviewMootLead: false,
        ...row,
      },
      civitaiUrl: 'https://civitai.test',
      canViewTrainingData: false,
      verdict: undefined,
      error: undefined,
      submit: () => () => {},
      actionHref: (a: string) => `?/${a}`,
      draft: { verdict: undefined, reason: '', note: '' },
    },
  }).body;

describe('the Needs review notice on a lock-review appeal', () => {
  it('says a lead on an already-set flag only closes the lead', () => {
    const body = draw({ needsReviewMootLead: true });
    expect(body).toContain('Needs review also lists this model');
    expect(body).toContain(MOOT_LEAD_NOTE);
  });

  it('adds nothing when the lead is a real decision', () => {
    const body = draw({ needsReviewMootLead: false });
    expect(body).toContain('Needs review also lists this model');
    expect(body).not.toContain(MOOT_LEAD_NOTE);
  });
});
