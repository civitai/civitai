// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Approve and Deny on a version's review page, server-rendered against each gate state. This config has
 * no Svelte plugin, so the component is compiled here with its imports pointed at stand-ins.
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
  CsamReportForm: `<script>let props = $props();</script>`,
};
const IMPORTS: [RegExp, string][] = [
  [/import \{ enhance \} from '\$app\/forms';/, 'const enhance = () => {};'],
  [
    /import \{ afterNavigate, goto \} from '\$app\/navigation';/,
    'const afterNavigate = () => {}; const goto = () => {};',
  ],
  [/import \{ Button \} from '[^']+';/, "import Button from './Button.js';"],
  [/import \{ toast \} from '[^']+';/, 'const toast = {};'],
  [
    /import \{ FormState \} from '\$lib\/form-state\.svelte';/,
    'class FormState { error = null; submitting = false; enhance = () => {}; }',
  ],
  [/import \{ LINK_CLASS \} from '\$lib\/format';/, "const LINK_CLASS = '';"],
  [/import CsamReportForm from '[^']+';/, "import CsamReportForm from './CsamReportForm.js';"],
];

const cache = path.resolve(import.meta.dirname, '../../../../node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, 'training-review-actions-'));
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

/** The client build, for what server rendering cannot show: a promise that has settled. */
function clientEntry(spec: string): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e.browser ?? e.default;
  return pathToFileURL(path.join(SVELTE, e)).href;
}

function emitClient(name: string, source: string) {
  const { js } = compile(source, { generate: 'client', filename: `${name}.svelte` });
  writeFileSync(
    path.join(work, 'client', `${name}.js`),
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${clientEntry(s)}'`
    )
  );
}

let Actions: unknown;
let ClientActions: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const [name, source] of Object.entries(STUBS)) emit(name, source);
  let source = readFileSync(
    path.resolve(import.meta.dirname, '../training-data/[versionId]/ReviewActions.svelte'),
    'utf8'
  );
  for (const [from, to] of IMPORTS) {
    expect(source).toMatch(from);
    source = source.replace(from, to);
  }
  emit('ReviewActions', source);
  mkdirSync(path.join(work, 'client'));
  for (const [name, stub] of Object.entries(STUBS)) emitClient(name, stub);
  emitClient('ReviewActions', source);
  ClientActions = (
    await import(
      /* @vite-ignore */ pathToFileURL(path.join(work, 'client', 'ReviewActions.js')).href
    )
  ).default;
  Actions = (
    await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'ReviewActions.js')).href)
  ).default;
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

/** A settled gate is passed as the value itself: server rendering shows a promise's pending branch. */
function show(gate: unknown) {
  document.body.innerHTML = render(Actions, {
    props: { gate, modelHref: '/models/1', csamContents: {}, canReportCsam: false },
  }).body;
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  return {
    approve: button('Approve')?.disabled,
    deny: button('Deny')?.disabled,
    text: document.body.textContent?.replace(/\s+/g, ' ') ?? '',
  };
}

describe('the version review actions', () => {
  it('disables Approve and Deny on a closed gate and says why', () => {
    const page = show({
      state: 'closed',
      reason: 'The gate is not under review (run: succeeded).',
    });
    expect(page).toMatchObject({ approve: true, deny: true });
    expect(page.text).toContain('The gate is not under review (run: succeeded).');
  });

  it('keeps Approve and Deny for a gate under review', () => {
    expect(show({ state: 'open' })).toMatchObject({ approve: false, deny: false });
  });

  it('keeps Approve and Deny when the gate could not be checked, and says so', () => {
    const page = show({ state: 'unknown', reason: 'The orchestrator did not answer.' });
    expect(page).toMatchObject({ approve: false, deny: false });
    expect(page.text).toContain('The orchestrator did not answer.');
  });

  it('keeps Approve and Deny, and says so, when the gate check rejects', async () => {
    const { mount, unmount, tick } = await import(/* @vite-ignore */ clientEntry('svelte'));
    const gate = Promise.reject(new Error('read failed'));
    gate.catch(() => {});
    document.body.innerHTML = '';
    const app = mount(ClientActions, {
      target: document.body,
      props: { gate, modelHref: '/models/1', csamContents: {}, canReportCsam: false },
    });
    await gate.catch(() => {});
    await tick();
    const button = (label: string) =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    expect({ approve: button('Approve')?.disabled, deny: button('Deny')?.disabled }).toEqual({
      approve: false,
      deny: false,
    });
    expect(document.body.textContent).toContain('The gate could not be checked.');
    unmount(app);
  });

  it('holds Approve and Deny while the check is in flight', () => {
    const page = show(new Promise(() => {}));
    expect(page).toMatchObject({ approve: true, deny: true });
    expect(page.text).toContain('Checking the gate');
  });
});
