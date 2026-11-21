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
 * The panel sits in the Needs review queue column's fixed-height header. This config has no Svelte
 * plugin, so it is compiled here, for the server (rendered to a string) and the client (mounted, to
 * click), with the UI components it imports swapped for plain stand-ins.
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
  // Holds queueEmpty in state, so a test can flip it after mount as a ruling's reload would.
  Harness: `<script>
  import Panel from './Panel.js';
  let { control, ...rest } = $props();
  let queueEmpty = $state(false);
  control.setQueueEmpty = (value) => (queueEmpty = value);
</script>
<Panel {...rest} {queueEmpty} />`,
};
const IMPORTS: [RegExp, string][] = [
  [
    /import \{ enhance \} from '\$app\/forms';/,
    'const enhance = (_form, submit) => { (globalThis.__panelSubmits ??= []).push(submit); };',
  ],
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
let Harness: unknown;
let render: (c: unknown, o: { props: unknown }) => { body: string };

beforeAll(async () => {
  for (const generate of ['server', 'client'] as const)
    for (const [name, source] of Object.entries(STUBS))
      if (name !== 'Harness') emit(name, source, generate);
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
  emit('Harness', STUBS.Harness, 'client');
  Harness = (
    await import(/* @vite-ignore */ pathToFileURL(path.join(work, 'client', 'Harness.js')).href)
  ).default;
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
    // Below lg the queue column is 320px, so the list needs its own smaller cap there.
    const narrowCap = /(^|\s)max-h-(\d+)(\s|$)/.exec(list.className);
    expect(Number(narrowCap?.[2])).toBeLessThanOrEqual(32);
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

  it('opens itself when the queue under it empties', async () => {
    const { mount, unmount, flushSync } = await import(/* @vite-ignore */ clientEntry('svelte'));
    document.body.innerHTML = '';
    const control: { setQueueEmpty?: (value: boolean) => void } = {};
    const app = mount(Harness, {
      target: document.body,
      props: { rows: LEADS, total: LEADS.length, civitaiUrl: 'https://civitai.com', control },
    });
    const leads = () => document.querySelectorAll('section[aria-label="Scan rated NSFW"] ul > li');

    expect(leads()).toHaveLength(0);
    control.setQueueEmpty!(true);
    flushSync();
    expect(leads()).toHaveLength(61);
    unmount(app);
  });

  it("says a ruling failed while hidden, so the failure isn't lost", async () => {
    const { mount, unmount, flushSync } = await import(/* @vite-ignore */ clientEntry('svelte'));
    document.body.innerHTML = '';
    const submits = ((globalThis as Record<string, unknown>).__panelSubmits = []) as Array<
      () => (o: { result: unknown; update: () => Promise<void> }) => Promise<void>
    >;
    const app = mount(ClientPanel, {
      target: document.body,
      props: {
        rows: LEADS,
        total: LEADS.length,
        civitaiUrl: 'https://civitai.com',
        queueEmpty: true,
      },
    });
    const alert = () =>
      document.querySelector('section[aria-label="Scan rated NSFW"] [role="alert"]');
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Rule')!
      .click();
    flushSync();
    expect(submits.length).toBeGreaterThan(0);

    const settle = submits[0]();
    document.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); // Hide mid-flight
    flushSync();
    expect(alert()).toBeNull();
    await settle({
      result: { type: 'failure', data: { error: 'Refused.' } },
      update: async () => {},
    });
    flushSync();
    expect(alert()?.textContent).toContain('A ruling failed');
    unmount(app);
  });

  it('keeps a failed ruling on its row after the row is closed', async () => {
    const { mount, unmount, flushSync } = await import(/* @vite-ignore */ clientEntry('svelte'));
    document.body.innerHTML = '';
    const submits = ((globalThis as Record<string, unknown>).__panelSubmits = []) as Array<
      () => (o: { result: unknown; update: () => Promise<void> }) => Promise<void>
    >;
    const app = mount(ClientPanel, {
      target: document.body,
      props: {
        rows: LEADS,
        total: LEADS.length,
        civitaiUrl: 'https://civitai.com',
        queueEmpty: true,
      },
    });
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === text
      )!;
    button('Rule').click();
    flushSync();
    await submits[0]()({
      result: { type: 'failure', data: { error: 'Refused.' } },
      update: async () => {},
    });
    flushSync();
    button('Close').click();
    flushSync();

    const first = document.querySelector('section[aria-label="Scan rated NSFW"] ul > li')!;
    expect(first.querySelector('[role="alert"]')?.textContent).toContain('Refused.');
    unmount(app);
  });
});
