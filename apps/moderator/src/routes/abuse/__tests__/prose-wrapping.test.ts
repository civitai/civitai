import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The board's two prose fields — a finding's `reason` and a run's `summary` — wrap inside their own
 * box.
 *
 * 🔴 THIS IS A PROXY, NOT A MEASUREMENT, AND IT MUST BE READ AS ONE. No SvelteKit app here has a
 * browser-test project, so nothing in this suite can render a page, let alone read a `scrollWidth`
 * or a bounding rectangle. What is asserted is the STRUCTURAL PRECONDITION the layout defect had:
 * the element holding the paragraph carried no wrapping opt-in, so it inherited the `TableCell`
 * primitive's `whitespace-nowrap` — correct for an id or a date, and the reason a multi-sentence
 * reason rendered on one line, ignored its own `max-w-*`, and painted across the column beside it.
 * A green run here says the opt-in is present; it does NOT say the page fits its viewport. That
 * claim needs a live re-measure.
 *
 * The locator is asserted before it is trusted: if no source renders the field, or more than one
 * does, the case fails rather than passing over nothing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ABUSE = join(HERE, '..');

/** Every Svelte source the given route directory is built from, so a later split is covered too. */
function sveltesIn(dir: string): { name: string; src: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.svelte'))
    .map((name) => ({ name, src: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * The opening tag of the element a source renders `{…field…}` inside — walk back from the
 * interpolation to the `<` that opens the tag containing it.
 *
 * Returns `null` for anything it cannot resolve (no interpolation, a closing tag, a `<` belonging to
 * an unrelated expression), so an unresolved locator reads as a failure rather than as a pass.
 */
export function hostTagFor(src: string, field: string): string | null {
  const at = src.search(new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}`));
  if (at === -1) return null;
  const open = src.lastIndexOf('<', at);
  if (open === -1 || src.startsWith('</', open)) return null;
  const close = src.indexOf('>', open);
  if (close === -1 || close > at) return null;
  return src.slice(open, close + 1);
}

/** Does this opening tag opt its contents into wrapping, rather than inheriting whatever it lands in? */
export const wraps = (tag: string): boolean =>
  /\bwhitespace-(normal|pre-line|pre-wrap)\b/.test(tag) && !/\bwhitespace-nowrap\b/.test(tag);

/** The one source in `dir` that renders `field`, with the tag it renders it in. */
function soleHost(dir: string, field: string): { name: string; tag: string } {
  const hosts = sveltesIn(dir)
    .map(({ name, src }) => ({ name, tag: hostTagFor(src, field) }))
    .filter((h): h is { name: string; tag: string } => h.tag !== null);
  expect(
    hosts.map((h) => h.name),
    `exactly one source should render \`${field}\``
  ).toHaveLength(1);
  return hosts[0];
}

describe('the locator can go wrong — controls', () => {
  it('finds the tag a field is rendered in', () => {
    expect(hostTagFor('<p class="x">{d.lead.reason}</p>', 'reason')).toBe('<p class="x">');
  });

  it('resolves nothing when the field is not rendered', () => {
    expect(hostTagFor('<p class="x">{d.lead.action}</p>', 'reason')).toBeNull();
  });

  it('rejects the exact tag the defect had — negative control', () => {
    // The pre-fix source, verbatim. If this ever reads as wrapping, every assertion below is
    // vacuous: the predicate would be accepting the thing it exists to refuse.
    expect(wraps('<TableCell class="max-w-2xl">')).toBe(false);
  });

  it('rejects a tag that opts in and then cancels itself', () => {
    expect(wraps('<TableCell class="whitespace-normal md:whitespace-nowrap">')).toBe(false);
  });

  it('accepts an explicit opt-in — positive control', () => {
    expect(wraps('<p class="break-words whitespace-normal">')).toBe(true);
  });
});

describe('a finding’s reason wraps inside its own box', () => {
  it('renders in an element that opts into wrapping', () => {
    const { name, tag } = soleHost(join(ABUSE, '[runId]'), 'reason');
    expect(wraps(tag), `${name} renders the reason in ${tag}`).toBe(true);
  });
});

describe('a run’s summary wraps inside its own box', () => {
  it('renders in an element that opts into wrapping', () => {
    const { name, tag } = soleHost(ABUSE, 'summary');
    expect(wraps(tag), `${name} renders the summary in ${tag}`).toBe(true);
  });
});
