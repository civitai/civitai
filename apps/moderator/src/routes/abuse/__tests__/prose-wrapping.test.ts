import { describe, expect, it } from 'vitest';
import { LIST_PAGE_DIR, RUN_PAGE_DIR, pageSurface, read, sveltesIn } from './page-sources';

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

/**
 * An INTERPOLATION naming `field` — `{…field…}` — and never a block tag.
 *
 * 🔴 A SVELTE BLOCK TAG IS NOT A RENDER, and the `(?![#:/@])` is the whole of what distinguishes them:
 * it skips `{#…}`, `{:…}`, `{/…}` and `{@…}` and leaves only interpolations. `{#if data.run.summary}`
 * names the field and draws nothing, and it sits ABOVE the paragraph that does, so a matcher without
 * the lookahead resolves to the wrong offset and reports the field as unrendered.
 *
 * 🔴 ONE SPELLING, USED BY EVERY READER HERE — not hypothetical: the disclosure assertion below was
 * first written with its own copy of this regex, the lookahead omitted, and confidently reported the
 * run summary as rendering outside any disclosure. Not exported: both callers are in this file, and
 * importing a helper FROM a `.test.ts` is a shape worth not establishing.
 */
const interpolationOf = (field: string): RegExp =>
  new RegExp(`\\{(?![#:/@])[^{}]*\\b${field}\\b[^{}]*\\}`);

/**
 * The opening tag of the element a source renders `{…field…}` inside — walk back from the
 * interpolation to the `<` that opens the tag containing it.
 *
 * Returns `null` for anything it cannot resolve (no interpolation, a closing tag, a `<` belonging to
 * an unrelated expression), so an unresolved locator reads as a failure rather than as a pass.
 */
export function hostTagFor(src: string, field: string): string | null {
  const at = src.search(interpolationOf(field));
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

  it('skips a block tag that names the field and draws nothing', () => {
    // The shape that made this locator lie: a guard above the paragraph that renders the field.
    const src = '<p class="a">x</p>\n{#if run.summary}\n  <p class="b">{run.summary}</p>\n{/if}';
    expect(hostTagFor(src, 'summary')).toBe('<p class="b">');
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

describe('every prose field on the board wraps inside its own box', () => {
  it.each([
    ['a finding’s reason', RUN_PAGE_DIR, 'reason'],
    ['a run’s summary, on the run page', RUN_PAGE_DIR, 'summary'],
    ['a run’s summary, on the list page', LIST_PAGE_DIR, 'summary'],
  ])('%s renders in an element that opts into wrapping', (_what, dir, field) => {
    const { name, tag } = soleHost(dir, field);
    expect(wraps(tag), `${dir}/${name} renders ${field} in ${tag}`).toBe(true);
  });
});

/**
 * Both of the run page's prose fields are now COLLAPSED, and both are still reachable.
 *
 * 🔴 WHY THIS IS A SEAM ASSERTION AND NOT TWO. The prose and the toggle that hides it live in
 * DIFFERENT FILES: the caller keeps the paragraph (so the wrapping guard above still resolves a tag),
 * and `ProseDisclosure.svelte` owns the `<details>`. Each half is correct on its own while the pair is
 * broken — a disclosure that renders its children outside the `<details>` shows the prose
 * unconditionally, and a caller that stops wrapping it in one hides nothing. Neither file's own read
 * can see that, so the relationship is asserted here.
 *
 * ⚠️ SOURCE-LEVEL, LIKE EVERYTHING ELSE IN THIS DIRECTORY. This says the markup is wired to collapse;
 * nothing here opens a browser, so it does NOT say the toggle works, that the label is legible, or
 * that the prose appears on click. That needs a live look.
 */
describe('the board’s prose is collapsed, and still reachable', () => {
  const DISCLOSURE = `${RUN_PAGE_DIR}/ProseDisclosure.svelte`;

  it('🔴 the disclosure renders its children INSIDE the `<details>`', () => {
    // Outside it, every caller's prose is permanently visible and the collapse is inert while every
    // other assertion here still passes.
    const src = read(DISCLOSURE);
    const details = /<details[\s\S]*?<\/details>/.exec(src)?.[0];
    expect(details, 'the disclosure must contain a `<details>`').toBeTruthy();
    expect(details).toMatch(/\{@render children\(\)\}/);
    // And the label is the toggle, not body text: a `<details>` whose `<summary>` is absent renders
    // the browser's bare "Details" marker, losing the obligation the label carries.
    expect(details).toMatch(/<summary[^>]*>\{label\}<\/summary>/);
  });

  it.each([
    ['a finding’s reason', RUN_PAGE_DIR, 'reason'],
    ['a run’s summary', RUN_PAGE_DIR, 'summary'],
  ])('%s sits inside a ProseDisclosure', (_what, dir, field) => {
    const host = sveltesIn(dir).find((s) => hostTagFor(s.src, field) !== null);
    expect(host, `no source in ${dir} renders ${field}`).toBeTruthy();
    const { name, src } = host!;
    const at = src.search(interpolationOf(field));
    const open = src.lastIndexOf('<ProseDisclosure', at);
    const close = src.indexOf('</ProseDisclosure>', open);
    expect(open, `${name} renders ${field} outside any disclosure`).toBeGreaterThan(-1);
    expect(close, `${name}'s disclosure around ${field} is never closed`).toBeGreaterThan(at);
  });

  it('🔴 the reason’s label carries the obligation to read it', () => {
    // Collapsing can hide text that decides the ruling: some detectors close a reason by warning that
    // the flagged behaviour may be legitimate and telling the reader to check the content first. A
    // label of "Details" would put that prerequisite behind a shrug, and it is the one cost the
    // operator accepted this change on.
    const card = read(`${RUN_PAGE_DIR}/FindingCard.svelte`);
    const label = /<ProseDisclosure label="([^"]+)"/.exec(card)?.[1];
    expect(label, 'the finding disclosure must be labelled').toBeTruthy();
    expect(label).toBe('Full detector reason — read before ruling');
  });

  /**
   * 🔴 A `<details>` HOLDS ITS OPEN STATE IN THE DOM AND NOTHING ELSE RESETS IT.
   *
   * Neither consumer remounts when its subject changes: `/abuse/1` → `/abuse/2` is the same route id,
   * so `+page.svelte` is reused with new `data`; and a decision id is `group:<groupKey>`, which is NOT
   * scoped by run, so the same id recurs across runs and Svelte reuses that `FindingCard`. Without a
   * `{#key}` a disclosure a moderator opened stays open on the next subject — which is the wall of
   * prose this change exists to remove, re-introduced on the second run they look at.
   *
   * Asserted as "the disclosure is INSIDE a `{#key}`", not merely "the file contains one", because a
   * `{#key}` somewhere else in the file resets something else.
   */
  it.each([
    ['the reason', 'FindingCard.svelte'],
    ['the run summary', '+page.svelte'],
  ])('🔴 %s disclosure sits inside a {#key} so it resets with its subject', (_what, file) => {
    const src = read(`${RUN_PAGE_DIR}/${file}`);
    const at = src.indexOf('<ProseDisclosure');
    expect(at, `${file} should render a ProseDisclosure`).toBeGreaterThan(-1);
    const key = src.lastIndexOf('{#key ', at);
    const closed = src.indexOf('{/key}', key);
    expect(key, `${file} wraps no {#key} around its disclosure`).toBeGreaterThan(-1);
    expect(closed, `${file}'s {#key} closes before the disclosure`).toBeGreaterThan(at);
    // And it must key on something that MOVES with the subject — an id, not a constant.
    expect(src.slice(key, at), `${file}'s {#key} must name an id`).toMatch(/\{#key [^}]*\bid\b/);
  });

  it('every disclosure on the run page is labelled, and none repeats a label', () => {
    // A ledger: two toggles sharing a label is a page that cannot say which prose is behind which.
    const labels = [...pageSurface(RUN_PAGE_DIR).matchAll(/<ProseDisclosure label="([^"]*)"/g)].map(
      (m) => m[1]
    );
    expect(labels.length, 'both prose fields should be behind a disclosure').toBe(2);
    for (const l of labels) expect(l.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
