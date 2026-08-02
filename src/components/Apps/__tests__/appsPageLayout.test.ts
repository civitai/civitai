import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The DOUBLE RULE under the `/apps` sub-nav — source guards (blocking `unit`
 * project).
 *
 * `AppsPageLayout` wrapped its header band in a `borderBottom` hairline while
 * Mantine's `Tabs.List` (inside `AppsSubNav`) already draws its own bottom
 * border, so every `/apps` page rendered two parallel lines ~8px apart under the
 * tabs. The band's rule is gone.
 *
 * 🔴 WHY A SOURCE GUARD AND NOT A RENDERED ONE. The claim has two halves: the
 * band draws no rule, AND the tabs still draw the one that remains. The first
 * half is asserted on the rendered DOM in `AppsPageLayout.browser.test.tsx`
 * (the removed border was an inline style, so it is observable). The second
 * half is NOT observable there: the component harness does not load
 * `@mantine/core/styles.css`, so `Tabs.List`'s border — which comes from a
 * stylesheet rule, not an inline style — computes to 0 whether or not it
 * exists, and an assertion on it would pass with the tabs deleted. Rather than
 * ship a green assertion that measures nothing, the second half is pinned
 * structurally here: the sub-nav still renders a default-variant `Tabs.List`,
 * which is the thing that owns the remaining rule.
 *
 * Also runs in CI, which the browser project does not.
 */

const LAYOUT = path.resolve(__dirname, '../AppsPageLayout.tsx');
const SUBNAV = path.resolve(__dirname, '../AppsSubNav.tsx');
const layoutSrc = () => readFileSync(LAYOUT, 'utf8');
const subNavSrc = () => readFileSync(SUBNAV, 'utf8');

describe('AppsPageLayout draws no rule of its own', () => {
  it('the file mentions no border at all', () => {
    // Deliberately broad: `borderBottom`, `border-bottom`, `borderBlockEnd` and a
    // shorthand `border:` would all re-create the double line.
    const src = layoutSrc();
    expect(src).not.toMatch(/borderBottom\s*:/);
    expect(src).not.toMatch(/border-bottom\s*:/);
    expect(src).not.toMatch(/borderBlockEnd\s*:/);
    expect(src).not.toMatch(/\bborder\s*:/);
  });

  it('the guard is reading a real file (not a silently-empty read)', () => {
    // A missing/renamed file would make every `not.toMatch` above pass vacuously.
    expect(layoutSrc()).toMatch(/export function AppsPageLayout/);
  });

  it('the header band keeps its TOP padding and drops its bottom one', () => {
    // The proximity grouping that replaced the rule: the header group hugs the
    // tabs above it (`pt="sm"`, no `pb`) and the parent `Stack gap="xl"` supplies
    // the larger separation to the page body. Reverting to `py="sm"` re-centres
    // the title between the two and the band stops reading as a band.
    const src = layoutSrc();
    expect(src).toMatch(/<Stack\s+gap="md"\s+pt="sm">/);
    // Scoped to a `<Stack …>` TAG, not the whole file — the prose above mentions
    // the reverted form, and a whole-file regex would match its own explanation.
    expect(src).not.toMatch(/<Stack[^>]*\bpy=/s);
  });
});

describe('the sub-nav still supplies the ONE remaining rule', () => {
  it('AppsSubNav renders a default-variant Tabs.List (the border owner)', () => {
    const src = subNavSrc();
    expect(src).toMatch(/<Tabs\b[^>]*variant="default"/s);
    expect(src).toMatch(/<Tabs\.List\b/);
  });
});
