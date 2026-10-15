// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Why `SSR_PENDING` exists: the model reports bug, end to end. A real server render, hydrated in a DOM,
 * then the parent `{#key}` moved between reports — what the page does when a mod clicks another row.
 *
 * This config has no Svelte plugin (see vitest.config.ts), so the components are compiled here, once
 * per side, and their `svelte/*` imports pointed at the matching build by hand: the node condition
 * would otherwise hand the browser half the server runtime.
 */
const require = createRequire(import.meta.url);
const SVELTE = path.dirname(require.resolve('svelte/package.json'));
const pkg = JSON.parse(readFileSync(path.join(SVELTE, 'package.json'), 'utf8'));
const { compile } = await import(pathToFileURL(path.join(SVELTE, 'src/compiler/index.js')).href);

type Cond = 'browser' | 'default';
function entry(spec: string, cond: Cond): string {
  let e = pkg.exports['.' + spec.slice('svelte'.length)];
  while (e && typeof e === 'object') e = e[cond] ?? e.default;
  return path.join(SVELTE, e).split(path.sep).join('/');
}

// Inside the app, not the OS temp dir: Vite will not load a module from outside the project.
const cache = path.resolve(import.meta.dirname, '../../../node_modules/.cache');
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, 'ssr-pending-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// The page's shape, cut to what matters: a keyed child whose promise is derived on the browser only.
const AWAIT = `{#await preview}<p class="loading">Loading</p>{:then p}{#if p}<div class="content">report {p.id}</div>{/if}{:catch}<p>failed</p>{/await}`;
const child = (onServer: string, guarded: boolean) => `<script>
  let { id } = $props();
  const preview = $derived(globalThis.__client ? Promise.resolve({ id }) : ${onServer});
</script>
${guarded ? `{#if preview}${AWAIT}{/if}` : AWAIT}`;

const parent = `<script>
  import Child from './Child.js';
  let id = $state(1);
  export function show(next) { id = next; }
</script>
<section>{#key id}<Child {id} />{/key}</section>`;

let run = 0;
async function build(onServer: string, guarded: boolean) {
  const dir = path.join(work, String(run++));
  const out: Record<string, string> = {};
  for (const [gen, cond] of [
    ['server', 'default'],
    ['client', 'browser'],
  ] as const) {
    for (const [name, source] of [
      ['Child', child(onServer, guarded)],
      ['Parent', parent],
    ]) {
      const { js } = compile(source, { generate: gen, filename: `${name}.svelte` });
      const file = path.join(dir, `${gen}-${name}.js`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        file,
        js.code
          .replace(
            /(from |import )['"](svelte[^'"]*)['"]/g,
            (_: string, k: string, s: string) => `${k}'${pathToFileURL(entry(s, cond)).href}'`
          )
          .replace("'./Child.js'", `'./${gen}-Child.js'`)
      );
      out[`${gen}-${name}`] = file.split(path.sep).join('/');
    }
  }
  return out;
}

/** What the preview column holds after each report is opened in turn. */
async function columnAfter(
  onServer: string,
  reports: number[],
  guarded = false
): Promise<string[][]> {
  const files = await build(onServer, guarded);
  (globalThis as { __client?: boolean }).__client = false;
  const { render } = await import(/* @vite-ignore */ entry('svelte/server', 'default'));
  const html = render((await import(/* @vite-ignore */ files['server-Parent'])).default, {}).body;

  document.body.innerHTML = `<div id="app">${html}</div>`;
  (globalThis as { __client?: boolean }).__client = true;
  const { hydrate, flushSync, tick } = await import(/* @vite-ignore */ entry('svelte', 'browser'));
  const app = hydrate((await import(/* @vite-ignore */ files['client-Parent'])).default, {
    target: document.getElementById('app')!,
  });

  const settle = async () => {
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  };
  const seen = () =>
    [...document.querySelectorAll('section .content')].map((n) => n.textContent!.trim());
  const states: string[][] = [];
  await settle();
  states.push(seen());
  for (const id of reports) {
    app.show(id);
    await settle();
    states.push(seen());
  }
  return states;
}

describe('SSR_PENDING', () => {
  it('the bug it fixes: `: null` on the server leaves the first report stuck in the column', async () => {
    expect(await columnAfter('null', [2, 1])).toEqual([
      ['report 1'],
      ['report 1', 'report 2'],
      ['report 1', 'report 1'],
    ]);
  });

  it('a never-settling promise on the server renders the branch the browser starts in', async () => {
    expect(await columnAfter('new Promise(() => {})', [2, 1])).toEqual([
      ['report 1'],
      ['report 2'],
      ['report 1'],
    ]);
  });

  // The other correct form, and why four panels keep `: null`: Svelte repairs a mismatched `{#if}`
  // on hydration, just not an `{#await}`. Those panels render nothing at all without JS, on purpose.
  it('`: null` is safe when an `{#if preview}` guards the await', async () => {
    expect(await columnAfter('null', [2, 1], true)).toEqual([
      ['report 1'],
      ['report 2'],
      ['report 1'],
    ]);
  });
});
