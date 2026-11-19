// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as comFace from '$lib/com-face';
import * as format from '$lib/format';
import * as restrictedVerdicts from '$lib/minor-flags/restricted-verdicts';
import type { RestrictedVerdictRow } from '$lib/minor-flags/restricted-verdicts';

// The compiled panel is imported outside Vite, where `$lib` does not resolve: its plain-TS imports
// are handed over through a global instead.
(globalThis as Record<string, unknown>).__panelLib = { comFace, format, restrictedVerdicts };

/**
 * The panel sits in the Needs review queue column's fixed-height header: drawn open with dozens of
 * leads it took the whole column and left the queue list 0px tall. Server-rendered here (this config
 * has no Svelte plugin), with the UI components it imports swapped for plain stand-ins.
 */
const require = createRequire(import.meta.url);
const SVELTE = path.dirname(require.resolve('svelte/package.json'));
const pkg = JSON.parse(readFileSync(path.join(SVELTE, 'package.json'), 'utf8'));
const { compile } = await import(pathToFileURL(path.join(SVELTE, 'src/compiler/index.js')).href);

function entry(spec: string, condition: 'default' | 'browser'): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e[condition] ?? e.default;
  return pathToFileURL(path.join(SVELTE, e)).href;
}
const serverEntry = (spec: string) => entry(spec, 'default');
const clientEntry = (spec: string) => entry(spec, 'browser');

const PASS = `<script>let { children, ...rest } = $props();</script>{@render children?.()}`;
const STUBS: Record<string, string> = {
  Button: `<script>let { children, type = 'button', variant, size, ...rest } = $props();</script>
<button {type} {...rest}>{@render children?.()}</button>`,
  ConfirmButton: PASS,
  ComFaceCard: PASS,
  MetaChip: PASS,
};
const IMPORTS: [RegExp, string][] = [
  [/import \{ enhance \} from '\$app\/forms';/, 'const enhance = () => {};'],
  [/import \{ invalidateAll \} from '\$app\/navigation';/, 'const invalidateAll = async () => {};'],
  [/import \{ Button \} from '[^']+';/, "import Button from './Button.js';"],
  [/import \{ ConfirmButton \} from '[^']+';/, "import ConfirmButton from './ConfirmButton.js';"],
  [/import ComFaceCard from '[^']+';/, "import ComFaceCard from './ComFaceCard.js';"],
  [/import MetaChip from '[^']+';/, "import MetaChip from './MetaChip.js';"],
  [
    /import \{ leadComCoverBlurred \} from '\$lib\/com-face';/,
    'const { leadComCoverBlurred } = globalThis.__panelLib.comFace;',
  ],
  [
    /import \{ LINK_CLASS, shortAge \} from '\$lib\/format';/,
    'const { LINK_CLASS, shortAge } = globalThis.__panelLib.format;',
  ],
  [
    /import \{[^}]*\} from '\$lib\/minor-flags\/restricted-verdicts';/,
    'const { LIFTED_NOTE } = globalThis.__panelLib.restrictedVerdicts;',
  ],
];

const cache = path.resolve(import.meta.dirname, '../../../../../../node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, 'restricted-verdicts-panel-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Compiles for the server (rendered to a string) or the client (mounted, so the toggle can be clicked). */
function emit(name: string, source: string, generate: 'server' | 'client') {
  const dir = path.join(work, generate);
  mkdirSync(dir, { recursive: true });
  const resolve = generate === 'server' ? serverEntry : clientEntry;
  const { js } = compile(source, { generate, filename: `${name}.svelte` });
  writeFileSync(
    path.join(dir, `${name}.js`),
    js.code.replace(
      /(from |import )['"](svelte[^'"]*)['"]/g,
      (_: string, k: string, s: string) => `${k}'${resolve(s)}'`
    )
  );
}

let Panel: unknown;
let ClientPanel: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const generate of ['server', 'client'] as const)
    for (const [name, source] of Object.entries(STUBS)) emit(name, source, generate);
  let panel = readFileSync(
    path.resolve(import.meta.dirname, '../RestrictedVerdicts.svelte'),
    'utf8'
  );
  for (const [from, to] of IMPORTS) {
    expect(panel).toMatch(from);
    panel = panel.replace(from, to);
  }
  emit('Panel', panel, 'server');
  emit('Panel', panel, 'client');
  const load = async (generate: string) =>
    (await import(/* @vite-ignore */ pathToFileURL(path.join(work, generate, 'Panel.js')).href))
      .default;
  Panel = await load('server');
  ClientPanel = await load('client');
  ({ render } = await import(/* @vite-ignore */ serverEntry('svelte/server')));
});

const lead = (modelId: number): RestrictedVerdictRow =>
  ({
    modelId,
    modelName: `model ${modelId}`,
    userId: 1,
    username: 'owner',
    restriction: 'sfwOnly',
    minor: false,
    poi: false,
    sfwOnly: true,
    nsfw: true,
    isPrivate: false,
    systemLocked: false,
    autoApplied: true,
    unticked: false,
    liftedBy: null,
    heldAt: '2026-11-01T00:00:00.000Z',
    source: 'text-scan',
    scanLevel: 8,
    scanLabels: [],
    scanReason: null,
    forensics: null,
    comFace: null,
  } as unknown as RestrictedVerdictRow);

const LEADS = Array.from({ length: 61 }, (_, i) => lead(990000001 + i));

function show(props: Record<string, unknown>) {
  document.body.innerHTML = render(Panel, {
    props: { rows: LEADS, total: LEADS.length, civitaiUrl: 'https://civitai.com', ...props },
  }).body;
  return document.querySelector('section[aria-label="Scan rated NSFW"]')!;
}

describe('the restricted-verdict panel above the Needs review queue', () => {
  it('starts collapsed to its heading, so the queue under it keeps the column', () => {
    const panel = show({});
    expect(panel.querySelectorAll('li')).toHaveLength(0);
    const toggle = panel.querySelector('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.textContent).toContain('(61)');
  });

  it('opened, lists every lead in a box that scrolls instead of growing', () => {
    const panel = show({ queueEmpty: true });
    const list = panel.querySelector('ul')!;
    expect(list.querySelectorAll(':scope > li')).toHaveLength(61);
    const cap = /\bmax-h-\[(\d+)vh\]/.exec(list.className);
    expect(Number(cap?.[1])).toBeLessThanOrEqual(50);
    expect(list.className).toMatch(/\boverflow-y-auto\b/);
    expect(panel.querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it('opens and closes on its toggle', async () => {
    const { mount, unmount, flushSync } = await import(/* @vite-ignore */ clientEntry('svelte'));
    document.body.innerHTML = '';
    const app = mount(ClientPanel, {
      target: document.body,
      props: { rows: LEADS, total: LEADS.length, civitaiUrl: 'https://civitai.com' },
    });
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const leads = () => document.querySelectorAll('section[aria-label="Scan rated NSFW"] ul > li');

    expect(leads()).toHaveLength(0);
    toggle.click();
    flushSync();
    expect(leads()).toHaveLength(61);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    flushSync();
    expect(leads()).toHaveLength(0);
    unmount(app);
  });
});
