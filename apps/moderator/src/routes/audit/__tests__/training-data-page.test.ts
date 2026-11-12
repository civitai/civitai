import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Training Data Review page header, server-rendered. This config has no Svelte plugin, so the page
 * is compiled here with its imports pointed at stand-ins.
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
  Badge: `<script>let { children } = $props();</script><span>{@render children?.()}</span>`,
  Button: `<script>let { children, href } = $props();</script><a {href}>{@render children?.()}</a>`,
  WorkflowGateQueue: `<script>let { gates } = $props();</script>`,
};
const IMPORTS: [RegExp, string][] = [
  [/import \{ Badge \} from '[^']+';/, "import Badge from './Badge.js';"],
  [/import \{ Button \} from '[^']+';/, "import Button from './Button.js';"],
  [/import \{ dateTime \} from '\$lib\/format';/, 'const dateTime = (d) => String(d);'],
  [
    /import WorkflowGateQueue from '[^']+';/,
    "import WorkflowGateQueue from './WorkflowGateQueue.js';",
  ],
];

const cache = path.resolve(import.meta.dirname, '../../../../node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, 'training-data-page-'));
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
    path.resolve(import.meta.dirname, '../training-data/+page.svelte'),
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

const row = (id: number, underReview: boolean, checked: boolean) => ({
  id,
  name: `v${id}`,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  modelId: 100 + id,
  modelName: `model ${id}`,
  workflowId: `${id}-20261005123456789`,
  underReview,
  checked,
});

function header(flags: { unanswered: boolean }) {
  const body = render(Page, {
    props: {
      data: {
        items: [row(1, true, true), row(2, false, false)],
        workflowFilterUnavailable: true,
        truncated: false,
        workflowGates: new Promise(() => {}),
        ...flags,
      },
    },
  }).body.replace(/<!--[^]*?-->/g, '');
  return body.replace(/\s+/g, ' ');
}

describe('the training data review page', () => {
  it('gives an exact count beside a row that answered unreadably, as the badge does', () => {
    const page = header({ unanswered: false });
    expect(page).toContain('>1 model version under review.');
    expect(page).not.toContain('At least');
    expect(page).not.toContain('The ones it did not answer for');
  });

  it('says the count is a floor when a row did not answer', () => {
    const page = header({ unanswered: true });
    expect(page).toContain('At least 1 model version under review.');
    expect(page).toContain('may have no workflow left, or be under review');
  });
});
