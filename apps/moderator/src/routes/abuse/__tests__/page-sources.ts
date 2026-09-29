import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reading the board's own source, for the properties no executed test in this app can see.
 *
 * The pages here are unrendered — no SvelteKit app in this repo has a browser-test project — so a
 * handful of structural claims are made by reading the markup instead. That is a weaker instrument
 * than a render, and the two rules that keep it honest both live here:
 *
 * 🔴 A CLAIM IS ABOUT A PAGE, NOT ABOUT A FILENAME. `pageSurface` concatenates every Svelte source
 * in a route directory, because splitting a panel out into a sibling component is an ordinary
 * refactor and must not quietly empty a guard that was pinned to `+page.svelte`. Six assertions
 * went vacuous-or-red exactly that way when the run page's verdict control moved into its own
 * component.
 *
 * 🔴 AND THE READ IS CONTROLLED BEFORE IT IS BELIEVED. A directory that resolves to nothing makes
 * every `toMatch` fail and every `not.toMatch` pass, so `pageSurface` refuses an empty surface
 * rather than returning one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `src/`, the root every path below is written against. */
export const APP = join(HERE, '../../..');

export const read = (p: string): string => readFileSync(join(APP, p), 'utf8');

/** The run detail page's directory, and the list page's. */
export const RUN_PAGE_DIR = 'routes/abuse/[runId]';
export const LIST_PAGE_DIR = 'routes/abuse';

/** Every Svelte source directly in a route directory — name and text, name order. */
export function sveltesIn(dir: string): { name: string; src: string }[] {
  return readdirSync(join(APP, dir))
    .filter((f) => f.endsWith('.svelte'))
    .sort()
    .map((name) => ({ name, src: read(join(dir, name)) }));
}

/**
 * One route directory's whole Svelte surface.
 *
 * Throws on an empty or missing directory: a silent `''` would turn every assertion over it into a
 * claim about nothing, and the `not.toMatch` half would report success for it.
 */
export function pageSurface(dir: string): string {
  const sources = sveltesIn(dir);
  if (sources.length === 0) throw new Error(`no Svelte sources under ${dir} — the read is wrong`);
  return sources.map((s) => s.src).join('\n');
}
