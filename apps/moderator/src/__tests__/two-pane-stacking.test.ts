import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test/strip-comments';

/**
 * ⚠️ A TEXT PIN over TWO NAMED LAYOUTS. Nothing here renders a page or measures a pixel.
 *
 * 🔴 WHAT IT IS NOT: a responsive lint. It says nothing about the other ~150 route components,
 * and a third page can reintroduce this defect freely. It pins the two layouts that had it.
 *
 * Both were a flex row with a fixed-width pane and no stacking breakpoint, so the pane kept its
 * width at every viewport: `w-56` (14rem) left roughly 80px of content at 390px on the page
 * carrying Ban / Purge / Mute, and `w-104` (26rem = 416px) was itself wider than the 342px
 * content box.
 *
 * The non-obvious half, and the reason this file exists rather than trusting review: converting
 * the container to a grid is NOT sufficient on its own. Below `lg` the grid is a single column, so
 * a fixed width put back on a PANE still overflows — while the diff reads as "already a grid, so
 * this is fine". `shrink-0` is also inert in a grid, so the old flex idiom can return looking
 * harmless.
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

/** `class="…"` values that pair an unconditional `w-<n>` with `shrink-0` — the flex-pane idiom. */
function fixedWidthPanes(source: string): string[] {
  return [...source.matchAll(/class="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((c) => /(^|\s)w-\d+(\s|$)/.test(c) && /(^|\s)shrink-0(\s|$)/.test(c));
}

describe.each(LAYOUTS)('$name stacks instead of pinning a pane', ({ file }) => {
  const source = read(file);

  // Positive control: every assertion below is a claim about parsed substrings, so an empty read
  // would satisfy them vacuously. Deliberately asserts NOTHING about `grid` or widths — a control
  // that shares the step under test is a second sample of the same unknown, not a control. (An
  // earlier version asserted `grid` here, and reverting the fix failed the control too, which
  // reads as a broken harness rather than a caught regression.)
  it('reads a real markup file', () => {
    expect(source.length).toBeGreaterThan(200);
    expect(source).toContain('class="');
    expect(source).toContain('</div>');
  });

  it('gives the two-pane container a lg: column template, so it is one column below lg', () => {
    expect(source).toMatch(/class="[^"]*\bgrid\b[^"]*\blg:grid-cols-\[/);
  });

  it('pins no pane to an unconditional fixed width', () => {
    // A breakpoint-prefixed width (`lg:w-56`) is fine — it cannot apply in the stacked layout.
    // An unprefixed one overflows below `lg` whether or not the container is a grid.
    expect(fixedWidthPanes(source)).toEqual([]);
  });
});
