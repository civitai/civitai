// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The release page's own markup, server-rendered: which form a key press in each field submits. This
 * config has no Svelte plugin, so the page is compiled here with its imports pointed at stand-ins that
 * keep the real components' submit semantics (`Button` defaults to `type="button"`).
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
  Button: `<script>let { children, type = 'button', variant, ...rest } = $props();</script>
<button {type} {...rest}>{@render children?.()}</button>`,
  Input: `<script>let { ...rest } = $props();</script><input {...rest} />`,
  ErrorAlert: `<script>let { message } = $props();</script><div class="error">{message}</div>`,
};
const IMPORTS: [RegExp, string][] = [
  [/import \{ enhance \} from '\$app\/forms';/, 'const enhance = () => {};'],
  [/import \{ Button \} from '[^']+';/, "import Button from './Button.js';"],
  [/import \{ Input \} from '[^']+';/, "import Input from './Input.js';"],
  [/import ErrorAlert from '[^']+';/, "import ErrorAlert from './ErrorAlert.js';"],
];

const cache = path.resolve(import.meta.dirname, '../../../../node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, 'csam-release-page-'));
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

let Page: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const [name, source] of Object.entries(STUBS)) emit(name, source);
  let page = readFileSync(
    path.resolve(import.meta.dirname, '../csam-flag-release/+page.svelte'),
    'utf8'
  );
  for (const [from, to] of IMPORTS) {
    expect(page).toMatch(from);
    page = page.replace(from, to);
  }
  emit('Page', page);
  Page = (await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'Page.js')).href)).default;
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

const COUNTED = {
  userId: 40,
  approvalRef: '2026-01-31-120000-0123abcd',
  reason: 'cleared on review',
  count: 3771,
  legs: ['ban'],
};

function show(form: unknown) {
  document.body.innerHTML = render(Page, {
    props: { data: { releasableLegs: ['ban'] }, form },
  }).body;
}

/** What Enter in `field` submits: the form's action, through its first submit button. */
function enterIn(field: string) {
  const input = document.querySelector<HTMLInputElement>(`input[name="${field}"]`);
  if (!input?.form) return null;
  const button = [...input.form.elements].find(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement && el.type === 'submit'
  );
  return { action: input.form.getAttribute('action'), button: button?.textContent?.trim() };
}

describe('the release page', () => {
  it('offers no release before a count', () => {
    show(null);
    expect(enterIn('userId')).toEqual({ action: '?/count', button: 'Count' });
    expect(document.querySelector('input[name="expectedCount"]')).toBeNull();
    expect(document.querySelector('form[action="?/release"]')).toBeNull();
  });

  it('after a count, Enter in the count field releases, and Enter in the count form only counts', () => {
    show({ counted: COUNTED });
    expect(enterIn('expectedCount')).toEqual({ action: '?/release', button: 'Release' });
    expect(enterIn('approvalRef')).toEqual({ action: '?/count', button: 'Count' });
  });

  it('releases exactly what was counted', () => {
    show({ counted: COUNTED });
    const release = document.querySelector('form[action="?/release"]')!;
    const sent = Object.fromEntries(
      [...release.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((i) => [
        i.name,
        i.value,
      ])
    );
    expect(sent).toEqual({
      userId: '40',
      approvalRef: '2026-01-31-120000-0123abcd',
      reason: 'cleared on review',
    });
  });

  it('keeps what was typed after a refusal, and asks for a new count before any release', () => {
    show({
      error: 'Nothing was released.',
      refill: { userId: '40', approvalRef: COUNTED.approvalRef, reason: COUNTED.reason },
    });
    const value = (name: string) =>
      document.querySelector<HTMLInputElement>(`form[action="?/count"] [name="${name}"]`)?.value;
    expect([value('userId'), value('approvalRef'), value('reason')]).toEqual([
      '40',
      COUNTED.approvalRef,
      COUNTED.reason,
    ]);
    expect(document.querySelector('form[action="?/release"]')).toBeNull();
  });

  it('says nothing is released yet, and gives the number to type without separators', () => {
    show({ counted: COUNTED });
    const status = document.querySelector('[role="status"]')!.textContent!;
    expect(status).toMatch(/NOTHING RELEASED YET/);
    expect(status).toMatch(/type 3771 below/);
    expect(status).not.toMatch(/3,771/);
  });
});
