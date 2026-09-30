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
 * 🔴 WHAT IT CANNOT SEE, first, because an earlier version of this file claimed more than it
 * delivered. It reads `class="…"` ATTRIBUTES only, so a width moved into `class={cn(…)}` — an
 * idiom `user-lookup/+layout.svelte` already uses for its nav links — is invisible. It is also
 * NOT a responsive lint: it pins the two elements marked `data-two-pane` / `data-pane` and says
 * nothing about any other page.
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

/** The `class` of the element marked `data-two-pane`, or null. */
function container(source: string): string | null {
  return (
    source
      .match(/data-two-pane[^>]*?class="([^"]*)"|class="([^"]*)"[^>]*?data-two-pane/)
      ?.slice(1)
      .find(Boolean) ?? null
  );
}

/** The `class` of every element marked `data-pane`. */
function panes(source: string): string[] {
  return [...source.matchAll(/data-pane[^>]*?class="([^"]*)"|class="([^"]*)"[^>]*?data-pane/g)].map(
    (m) => m[1] ?? m[2]
  );
}

describe.each(LAYOUTS)('$name stacks instead of pinning a pane', ({ file }) => {
  const source = read(file);

  // Positive control. Asserts nothing about widths or breakpoints — a control that shares the step
  // under test is a second sample of the same unknown, not a control.
  it('finds the marked container and both panes', () => {
    expect(container(source)).not.toBeNull();
    expect(panes(source)).toHaveLength(2);
  });

  it('makes its two-column arrangement conditional on a breakpoint', () => {
    // Either idiom is accepted: a `*:grid-cols-` template, or a `*:w-<n>` pane. This app uses both,
    // and the flex one is the majority. What must not happen is two columns at EVERY width.
    const gated =
      new RegExp(BREAKPOINT + 'grid-cols-').test(container(source) ?? '') ||
      panes(source).some((c) => new RegExp(BREAKPOINT + String.raw`w-\d`).test(c));
    expect(
      gated,
      'no breakpoint-gated two-column arrangement: the panes sit side by side at every width'
    ).toBe(true);
  });

  it('pins no pane to an unconditional width', () => {
    // `min-w-0` is the opposite of pinning and must not trip this, hence `[1-9]`. `basis-` and an
    // arbitrary `w-[…]` are included: both hold a pane's width as firmly as `w-56` does.
    const pinned = panes(source).filter((c) =>
      new RegExp(String.raw`(?:^|\s)(?:min-w|w|basis)-(?:[1-9]|\[)`).test(c)
    );
    expect(pinned).toEqual([]);
  });
});
