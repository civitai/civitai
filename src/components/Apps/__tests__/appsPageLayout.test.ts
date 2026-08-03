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

  it('the header band carries NO vertical padding of its own', () => {
    // UPDATED (vertical-padding pass): this used to pin `pt="sm"` on the band.
    // That pad was dropped deliberately — it sat ABOVE the tabs, i.e. outside the
    // tabs↔title relationship, so it only pushed the band down the page and was
    // never part of the grouping (measured: the two gaps below are identical at
    // 16px/32px with and without it).
    //
    // The `pb` half of the original assertion is UNCHANGED in force and is what
    // still matters: a `pb` sits BETWEEN the title and the body and would make
    // the title equidistant, which is exactly the float the removed rule left
    // behind. `py` would reintroduce it, so both are still banned.
    const src = layoutSrc();
    expect(src).toMatch(/<Stack\s+gap="md">/);
    // Scoped to a `<Stack …>` TAG, not the whole file — the prose above mentions
    // the reverted forms, and a whole-file regex would match its own explanation.
    expect(src).not.toMatch(/<Stack[^>]*\bpy=/s);
    expect(src).not.toMatch(/<Stack[^>]*\bpb=/s);
  });

  it('🔴 the PROXIMITY PAIR that groups the band is intact (16px in / 32px out)', () => {
    // INVARIANT GUARD — passes both before and after the vertical-padding pass;
    // it is NOT regression coverage for that change. It exists because the pair
    // below is the ONLY thing grouping the header band since the duplicate rule
    // was removed, and the padding pass deliberately moved everything AROUND it.
    // Pinning it makes "the padding is free to move, these two are not" (the
    // comment in AppsPageLayout) enforceable rather than advisory.
    const src = layoutSrc();
    // Band-internal gap: tabs -> title.
    expect(src).toMatch(/<Stack\s+gap="md">/);
    // Parent gap: band -> page body. Was `lg` once; 20-vs-16 grouped nothing.
    expect(src).toMatch(/<Stack\s+gap="xl">/);
    expect(src).not.toMatch(/<Stack\s+gap="lg">/);
  });

  it('the layout Container drops its TOP pad but keeps a bottom one', () => {
    // Regression coverage for the vertical-padding pass: FAILS on pre-change
    // source, which carried `py="md"` (a 16px top pad under the global header).
    //
    // `pb` is asserted PRESENT, not merely "no py": this Container is the
    // outermost element on every `/apps/*` page, so its bottom pad is the only
    // thing keeping the last grid/table row off whatever follows. Dropping to a
    // bare `<Container size={size}>` would satisfy a "no py" check alone.
    const src = layoutSrc();
    expect(src).toMatch(/<Container\s+size=\{size\}\s+pb="md">/);
    expect(src).not.toMatch(/<Container[^>]*\bpy=/s);
    expect(src).not.toMatch(/<Container[^>]*\bpt=/s);
  });

  it('HORIZONTAL geometry is untouched by the vertical pass', () => {
    // INVARIANT GUARD — green before and after. The pass was scoped to vertical
    // padding; these pin the things it was explicitly not allowed to move, so a
    // future "tighten the apps chrome" edit can't quietly take the side gutters
    // or the container width with it.
    const src = layoutSrc();
    // Width still comes from the caller's `size` prop, not a hardcoded value.
    expect(src).toMatch(/<Container\s+size=\{size\}/);
    // No horizontal padding override of any kind on the Container.
    expect(src).not.toMatch(/<Container[^>]*\b(px|pl|pr)=/s);
  });
});

describe('the sub-nav still supplies the ONE remaining rule', () => {
  it('AppsSubNav renders a default-variant Tabs.List (the border owner)', () => {
    const src = subNavSrc();
    expect(src).toMatch(/<Tabs\b[^>]*variant="default"/s);
    expect(src).toMatch(/<Tabs\.List\b/);
  });
});

describe('the sub-nav tab row is tightened on the BLOCK axis only', () => {
  it('the tab padding override exists and is block-axis', () => {
    // Regression coverage for the vertical-padding pass: FAILS on pre-change
    // source, which had no `styles` prop on `<Tabs>` at all (the row ran at
    // Mantine's default 10px block padding = a 37px row; it is 29px now).
    const src = subNavSrc();
    expect(src).toMatch(/styles=\{\{\s*tab:\s*\{\s*paddingBlock:/);
  });

  it('🔴 the tab override can NEVER touch the inline (horizontal) axis', () => {
    // The load-bearing half. `paddingBlock` overrides only the block axis, so the
    // 16px inline padding from Mantine's `padding: xs md` shorthand survives and
    // the tabs keep their horizontal hit area. Swapping it for a `padding`
    // shorthand — the single most natural "cleanup" edit here — would silently
    // reset that inline padding to whatever the shorthand says and shrink every
    // tab's click target. Measured: tab width 133.27px before AND after.
    //
    // Scoped to the `styles={{ tab: … }}` block so the surrounding prose (which
    // names the shorthand it is warning about) can't satisfy or trip the check.
    const styleBlock = subNavSrc().match(/styles=\{\{\s*tab:\s*\{([^}]*)\}/)?.[1];
    expect(styleBlock).toBeTruthy();
    expect(styleBlock).not.toMatch(/\bpadding\s*:/);
    expect(styleBlock).not.toMatch(/paddingInline|paddingLeft|paddingRight/);
  });
});
