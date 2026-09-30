import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test/strip-comments';

/**
 * ⚠️ A TEXT PIN OVER TWO NAMED LAYOUTS. Nothing here renders a page or measures a pixel.
 *
 * Both were a flex row with a fixed-width pane and no stacking breakpoint, so the pane kept its
 * width at every viewport and squeezed the content column — on `user-lookup`, the page carrying
 * Ban / Purge / Mute.
 *
 * 🔴 WHAT IT CANNOT SEE. It reads the markup as TEXT, so a width that never appears literally in
 * a `data-pane` element's `class` — computed in the script, or applied by a child component — is
 * invisible. Two shapes that LOOK like holes are not: a width interpolated into a literal class
 * (`class="min-w-0 {x ? 'w-56' : ''}"`) is matched, and `class={cn(…)}` makes the pane's class
 * unreadable, which the control below reports rather than passing over. Both measured.
 * It is also NOT a responsive lint: it pins the elements marked `data-two-pane` / `data-pane` on
 * these two layouts and says nothing about any other page.
 *
 * The markers exist so the pin can tell a PANE from an icon. Scanning every `class="…"` in the
 * file made an ordinary `<span class="w-4 shrink-0">` — live elsewhere in this app — fail a test
 * whose message pointed at the container.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => stripComments(readFileSync(path.resolve(dir, '..', p), 'utf8'));

const LAYOUTS = [
  { name: 'retool/user-lookup', file: 'routes/retool/user-lookup/+layout.svelte' },
  {
    name: 'audit/generator-restrictions',
    file: 'routes/audit/generator-restrictions/+page.svelte',
  },
] as const;

/**
 * A breakpoint token at the START of a class, so `max-lg:` and `not-lg:` do NOT count.
 * They are not stacking: `max-lg:grid-cols-[14rem_1fr]` gives two columns ONLY BELOW `lg`, which
 * is the original defect inverted and confined to exactly the widths this pin exists to protect.
 */
const BREAKPOINT = String.raw`(?:^|\s)(?:sm|md|lg|xl|2xl):`;

/**
 * Opening tags, tolerating a `>` inside a quoted value or a `{…}` expression — `onclick={() => x}`
 * and `title="a > b"` are both ordinary Svelte, and a naive `[^>]*` drops the whole element.
 */
const TAGS = /<[a-zA-Z][a-zA-Z0-9-]*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^>"'{])*>/g;

const classOf = (tag: string) => tag.match(/\sclass="([^"]*)"/)?.[1] ?? null;
const tagsMarked = (source: string, marker: string) =>
  [...source.matchAll(TAGS)]
    .map((m) => m[0])
    .filter((t) => new RegExp(`\\s${marker}[\\s=>]`).test(t));

/** The `class` of the element marked `data-two-pane`, or null. */
function container(source: string): string | null {
  const [tag] = tagsMarked(source, 'data-two-pane');
  return tag ? classOf(tag) : null;
}

/**
 * The `class` of every element marked `data-pane`. `null` where the element has no LITERAL
 * `class="…"` — e.g. `class={cn(…)}` — which this pin cannot read and must not silently treat as
 * "no width": the control below turns that into a loud failure rather than a false pass.
 */
function panes(source: string): (string | null)[] {
  return tagsMarked(source, 'data-pane').map(classOf);
}

describe.each(LAYOUTS)('$name stacks instead of pinning a pane', ({ file }) => {
  const source = read(file);

  // Positive control. Asserts nothing about widths or breakpoints — a control that shares the step
  // under test is a second sample of the same unknown, not a control.
  it('finds the marked container and both panes, each with a readable class', () => {
    expect(container(source)).not.toBeNull();
    expect(panes(source)).toHaveLength(2);
    // A dynamic class (`class={cn(…)}`) is unreadable here. Fail loudly rather than let the width
    // check pass over a pane it cannot actually see.
    expect(
      panes(source).filter((c) => c === null),
      'a data-pane element has no literal class="…"; this pin cannot see its width'
    ).toEqual([]);
  });

  it('makes its two-column arrangement conditional on a breakpoint', () => {
    // Either idiom is accepted: a `*:grid-cols-` template, or a `*:w-<n>` pane. This app uses both,
    // and the flex one is the majority. What must not happen is two columns at EVERY width.
    const gated =
      new RegExp(BREAKPOINT + 'grid-cols-').test(container(source) ?? '') ||
      panes(source).some((c) => new RegExp(BREAKPOINT + String.raw`w-\d`).test(c ?? ''));
    expect(
      gated,
      'no breakpoint-gated two-column arrangement: the panes sit side by side at every width'
    ).toBe(true);
  });

  it('pins no pane to an unconditional width', () => {
    // Numeric, arbitrary AND keyword: `w-max`/`min-w-fit`/`w-screen`/`basis-full` hold a pane as
    // firmly as `w-56`, and all three survived while this only checked `[1-9]` or `[`.
    // `min-w-0` and `w-0` are the opposite of pinning and must not trip it, hence `[1-9]`.
    const pinned = panes(source).filter((c) =>
      // Boundary is any of whitespace, string start, quote or brace — a width INTERPOLATED into a
      // literal class (`class="min-w-0 {x ? 'w-56' : ''}"`) is preceded by a quote, not a space,
      // and an idiom that common must not be a silent hole.
      new RegExp(String.raw`(?:^|[\s'"{(])(?:min-w|w|basis)-(?:[1-9]|\[|max|fit|screen|full)`).test(
        c ?? ''
      )
    );
    expect(pinned).toEqual([]);
  });
});
