import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../../test/strip-comments';

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

/**
 * 🔴 EVERY READ HERE GOES THROUGH `stripComments` — this app's declared choke point for raw-source
 * pins, and this module bypassed it. A text pin cannot tell code from a sentence ABOUT the code, so a
 * pin written against raw source passes on its own witness in a comment and keeps passing after the
 * code it pins is deleted. `src/test/strip-comments.ts` carries the three recorded incidents; a fourth
 * is in this very directory — `user-findings-round-trip.test.ts` records two mutants that SURVIVED
 * because `/truncated/` matched a comment and a type annotation. Over-stripping is the safe direction:
 * it makes a pin fail loudly rather than pass quietly.
 */
export const read = (p: string): string => stripComments(readFileSync(join(APP, p), 'utf8'));

/**
 * The same file WITHOUT the strip — for one purpose only: proving `read`'s strip is still wired.
 *
 * 🔴 NOT FOR PINS. A pin over this is a pin that can pass on its own witness in a comment, which is the
 * whole defect `read` exists to prevent. Its only legitimate use is the positive control that would
 * otherwise be impossible: "the raw file DOES carry comments, so `read` removing them means something".
 */
export const readRaw = (p: string): string => readFileSync(join(APP, p), 'utf8');

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

/**
 * Every `.ts` and `.svelte` source under `dir`, RECURSIVELY — for a claim about a whole feature's
 * subtree rather than one route directory.
 *
 * Throws on an empty result, as `pageSurface` does — but ⚠️ THAT THROW IS NOT WHAT MAKES A CALLER
 * HONEST, and measured: removing it changes no test result. No directory under `src/` is free of
 * `.ts`/`.svelte`, so it fires only when the read itself is broken (a wrong extension, a wrong dir),
 * and in that case the caller's own floor assertion fires too. A claim of the form "this string
 * appears nowhere under X" is satisfied by reading nothing at all, so **the caller must assert a
 * MINIMUM count** — see the positive control in `finding-presentation.test.ts`. Returns paths relative
 * to `src/`, which is what a failure message needs to name.
 */
export function sourcesUnder(dir: string): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  for (const entry of readdirSync(join(APP, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.svelte')) continue;
    // `parentPath` is absolute; re-root it on `src/` so a failure names a path someone can open.
    const name = join(entry.parentPath, entry.name).slice(join(APP, '').length);
    out.push({ name, src: read(name) });
  }
  if (out.length === 0) throw new Error(`no sources under ${dir} — the read is wrong`);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
