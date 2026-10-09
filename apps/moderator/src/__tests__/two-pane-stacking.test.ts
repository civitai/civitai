import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test/strip-comments';
import { classOf, hasAttr, tokenizeTags } from '../test/svelte-tags';

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
    name: 'restrictions queue',
    file: 'lib/components/restrictions/RestrictionQueue.svelte',
  },
] as const;

/** Tailwind v4 defaults; this app overrides no `--breakpoint-*`. */
const BREAKPOINT_PX = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } as const;

/**
 * Everything between the viewport edge and the content column once the panes sit side by side:
 * the app sidebar (`SIDEBAR_WIDTH` 16rem, in FLOW from 768px up), the page container's `px-6`,
 * and the `gap-6` between the panes.
 *
 * 🔴 This arithmetic is the whole point of the test below. An earlier revision of this PR moved a
 * breakpoint to `md` on figures that OMITTED the sidebar, which put the content column at 216px —
 * narrower than at 767px, where the sidebar is off-canvas. Encoding it here is what stops that
 * being re-derived wrongly; a change to any of these three constants must be made here too.
 */
const SIDEBAR_PX = 256;
const CONTAINER_PX_6 = 48;
const GAP_6 = 24;

/**
 * The floor the sibling layout already sits at: `generator-restrictions` accepts 280px of content
 * at `lg`. A narrower column than something already shipped is the signal to raise the breakpoint,
 * not a law of nature — raise this only with a measurement.
 */
const MIN_CONTENT_PX = 280;

/**
 * A breakpoint token at the START of a class, so `max-lg:` and `not-lg:` do NOT count.
 * They are not stacking: `max-lg:grid-cols-[14rem_1fr]` gives two columns ONLY BELOW `lg`, which
 * is the original defect inverted and confined to exactly the widths this pin exists to protect.
 */
const BREAKPOINT = String.raw`(?:^|\s)(?:sm|md|lg|xl|2xl):`;

/**
 * Elements carrying a marker attribute, as their literal `class="…"` (null where it is dynamic).
 * The tag grammar itself is shared — `src/test/svelte-tags.ts` — because it was written four times
 * across this file and `checkbox-primitive.test.ts` and the copies had diverged: this one's name
 * charset could not match a dotted component tag, so an element whose class it needed to read could
 * silently drop out of the scan. The shared one documents what it still cannot parse.
 */
const classesMarked = (source: string, marker: string): (string | null)[] =>
  tokenizeTags(source)
    .filter((t) => !t.closing && hasAttr(t, marker))
    .map(classOf);

/** The `class` of the element marked `data-two-pane`, or null. */
function container(source: string): string | null {
  return classesMarked(source, 'data-two-pane')[0] ?? null;
}

/**
 * The `class` of every element marked `data-pane`. `null` where the element has no LITERAL
 * `class="…"` — e.g. `class={cn(…)}` — which this pin cannot read and must not silently treat as
 * "no width": the control below turns that into a loud failure rather than a false pass.
 */
function panes(source: string): (string | null)[] {
  return classesMarked(source, 'data-pane');
}

/**
 * The breakpoint at which the panes go side by side, and the pane's width in rem — both read from
 * the markup. Handles the grid idiom (`lg:grid-cols-[14rem_1fr]`) and the flex one
 * (`lg:w-56` on a pane, which this app uses more often); returns null when neither is readable,
 * which the assertion reports rather than skipping.
 *
 * Takes the LAST breakpoint, not the first: Tailwind is written small-to-large, so a container
 * refined as `md:grid-cols-1 lg:grid-cols-[14rem_1fr]` is one column at `md` and two at `lg` --
 * strictly safer than a bare `lg:`, and reading the first token would fail it for being safer.
 */
function paneGeometry(source: string): { bp: string; at: number; paneRem: number } | null {
  const cls = container(source) ?? '';
  const grid = [...cls.matchAll(/(?:^|\s)(sm|md|lg|xl|2xl):grid-cols-\[(\d+(?:\.\d+)?)rem_/g)].at(
    -1
  );
  if (grid) {
    return {
      bp: grid[1],
      at: BREAKPOINT_PX[grid[1] as keyof typeof BREAKPOINT_PX],
      paneRem: Number(grid[2]),
    };
  }
  const flex = panes(source)
    .flatMap((c) => [...(c ?? '').matchAll(/(?:^|\s)(sm|md|lg|xl|2xl):w-(\d+)(?:\s|$)/g)])
    .at(-1);
  if (flex) {
    return {
      bp: flex[1],
      at: BREAKPOINT_PX[flex[1] as keyof typeof BREAKPOINT_PX],
      paneRem: Number(flex[2]) / 4,
    };
  }
  return null;
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

  it('picks a breakpoint and pane width that leave a usable content column', () => {
    // The assertion that would have caught the `md` experiment this PR reverted: at `md` the app
    // sidebar has just become 256px of FLOW width, so the content column is NARROWER at 768px
    // than at 767px, where the sidebar is off-canvas.
    //
    // 🔴 BOTH operands are read from the markup, never from a table beside it. An earlier revision
    // carried the pane width as a constant here, which made this blind to the very thing its own
    // failure message told you to change: widening the grid track to `46rem` — a NEGATIVE content
    // column — passed. A duplicated literal is the one that drifts.
    const geometry = paneGeometry(source);
    expect(
      geometry,
      'cannot read a breakpoint and a pane width from this container, so the content column is ' +
        'unchecked. Express the panes as `<bp>:grid-cols-[<n>rem_1fr]`, or extend paneGeometry().'
    ).not.toBeNull();
    const { bp, at, paneRem } = geometry!;
    const content = at - SIDEBAR_PX - CONTAINER_PX_6 - paneRem * 16 - GAP_6;
    expect(
      content,
      `at \`${bp}\` (${at}px) a ${paneRem}rem pane leaves ${content}px of content — below the ` +
        `${MIN_CONTENT_PX}px the sibling layout already sits at. Raise the breakpoint, or narrow ` +
        `the pane.`
    ).toBeGreaterThanOrEqual(MIN_CONTENT_PX);
  });

  it('pins no pane to an unconditional width', () => {
    // Numeric, arbitrary, and the three CONTENT/VIEWPORT keywords: `w-max`, `w-fit`/`min-w-fit`
    // and `w-screen` size a pane from something other than its grid track and so can overflow it.
    // `-full` is deliberately NOT here: `w-full` is 100% of the track, a no-op either side of the
    // breakpoint and a 65-occurrence idiom in this app, and `basis-full` is inert in a grid and,
    // IN A WRAPPING flex row, forces the item onto its own line rather than pinning it. `w-0`/`min-w-0` are likewise not pinning, hence `[1-9]`.
    const pinned = panes(source).filter((c) =>
      // Boundary is any of whitespace, string start, quote or brace — a width INTERPOLATED into a
      // literal class (`class="min-w-0 {x ? 'w-56' : ''}"`) is preceded by a quote, not a space,
      // and an idiom that common must not be a silent hole.
      new RegExp(String.raw`(?:^|[\s'"{(])(?:min-w|w|basis)-(?:[1-9]|\[|max|fit|screen)`).test(
        c ?? ''
      )
    );
    expect(pinned).toEqual([]);
  });
});
