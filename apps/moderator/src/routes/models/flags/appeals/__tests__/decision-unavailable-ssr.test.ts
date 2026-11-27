// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A lock-review appeal whose model is flagged as a minor, server-rendered: Approve is disabled, and a
 * disabled button takes no pointer events so its `title` never shows. The reason has to be on the page
 * as text, and the button has to point at it. This config has no Svelte plugin, so the real
 * LockReviewDetail and TriageDecisionBar are compiled here; the frame draws only its decision area and
 * the key button is a plain <button> that keeps the attributes the page gives it.
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
const STUBS: Record<string, string> = {
  Empty: '',
  Frame: `<script>const props = $props();</script>{@render props.decision?.()}`,
  Key: `<script>const { children, key, primary, reasons, tone, selected, ...rest } = $props();</script><button {...rest}>{@render children()}</button>`,
};

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

const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

function stubImports(source: string): string {
  return source
    .replace(/import \{ enhance \} from '\$app\/forms';/, 'const enhance = () => ({});')
    .replace(
      /import \{[^}]+\} from '\$lib\/triage\/reason-picker\.svelte';/,
      `const reasonPicker = { open: null };
const closeReasonPickerBeyond = () => {};
const noteReasonChosen = () => {};
const resetReasonPicker = () => {};
const submitAwaitingNote = () => false;`
    )
    .replace(/import \{ modelFlagDetail \} from '[^']+';/, 'const modelFlagDetail = () => null;')
    .replace(/import \{ [\w, ]+ \} from '@tabler\/icons-svelte[^']*';/g, '')
    .replace(
      /import ModelFlagDetailFrame from '[^']+';/,
      "import ModelFlagDetailFrame from './Frame.js';"
    )
    .replace(/import TriageKeyButton from '[^']+';/, "import TriageKeyButton from './Key.js';")
    .replace(/import TriageDecisionBar from '[^']+';/, "import TriageDecisionBar from './Bar.js';")
    .replace(/import (\w+) from '[^']+\.svelte';/g, "import $1 from './Empty.js';");
}

let Detail: unknown;
let Bar: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const [name, source] of Object.entries(STUBS)) emit(name, source);
  emit('Unavailable', read('lib/components/triage/DecisionUnavailable.svelte'));
  emit(
    'Bar',
    read('lib/components/triage/TriageDecisionBar.svelte').replace(
      "'./DecisionUnavailable.svelte'",
      "'./Unavailable.js'"
    )
  );
  emit('Detail', stubImports(read('routes/models/flags/appeals/LockReviewDetail.svelte')));
  const load = async (n: string) =>
    (await import(/* @vite-ignore */ pathToFileURL(path.join(work, `${n}.js`)).href)).default;
  Detail = await load('Detail');
  Bar = await load('Bar');
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

const WHY = 'Flagged as a real person or a minor since the request; its locks stay.';

const draw = (row: Record<string, unknown>) =>
  render(Detail, {
    props: {
      row: {
        modelId: 1,
        appealId: 2,
        minor: false,
        poi: false,
        lockReview: ['nsfw'],
        lockedProperties: ['nsfw'],
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

describe('a decision button that is disabled', () => {
  it('says why in text, and the button points at it', () => {
    const body = draw({ minor: true });
    const text = body.match(/<p id="([^"]+)" data-testid="decision-unavailable"[^>]*>([^<]*)</);
    expect(text?.[2].trim()).toBe(WHY);
    const approve = body.match(/<button[^>]*value="Approved"[^>]*>/)?.[0] ?? '';
    expect(approve).toContain('disabled');
    expect(approve).toContain(`aria-describedby="${text?.[1]}"`);
  });

  it('draws no reason when every decision is available', () => {
    const body = draw({ minor: false, poi: false });
    expect(body).not.toContain('decision-unavailable');
    expect(body).not.toContain('aria-describedby');
  });
});

describe('TriageDecisionBar unavailable', () => {
  const bar = (unavailable: (string | null | undefined)[]) =>
    render(Bar, { props: { buttons: (() => {}) as never, unavailable } }).body;

  it('lists each reason once and skips blanks', () => {
    const body = bar(['One.', null, 'One.', undefined, 'Two.']);
    expect(body.match(/data-testid="decision-unavailable"/g)).toHaveLength(1);
    expect(body).toContain('One. Two.');
  });

  it('draws nothing when nothing is unavailable', () => {
    expect(bar([null])).not.toContain('decision-unavailable');
  });
});
