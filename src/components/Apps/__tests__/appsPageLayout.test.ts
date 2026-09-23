import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `AppsPageLayout` — source guards (blocking `unit` project).
 *
 * 🔴 THE DOUBLE RULE THIS FILE WAS WRITTEN FOR IS GONE TWICE OVER, AND THE HISTORY IS
 * KEPT BECAUSE IT EXPLAINS WHAT THE SURVIVING GUARDS PROTECT. The layout used to wrap
 * its header band in a `borderBottom` hairline while Mantine's `Tabs.List` (inside the
 * old `AppsSubNav`) drew its own bottom border, so every `/apps` page rendered two
 * parallel lines ~8px apart under the tabs. The band's rule was removed first; then the
 * TAB STRIP ITSELF was replaced by a vertical left rail, so there is no second rule left
 * to duplicate and no `Tabs.List` to assert about.
 *
 * ⚠️ THREE GUARDS DIED WITH THE TAB STRIP AND ARE DELETED RATHER THAN RE-POINTED,
 * because their subject no longer exists — stated so the deletions read as decisions:
 *   • `AppsSubNav renders a default-variant Tabs.List (the border owner)` — there is no
 *     Tabs.List, and the rail draws no rule at all.
 *   • `the tab padding override exists and is block-axis` and `the tab override can
 *     NEVER touch the inline (horizontal) axis` — both pinned a `styles={{tab:
 *     {paddingBlock}}}` prop on a `<Tabs>` that has been removed. A rail entry's padding
 *     is a Tailwind class on an anchor, with no shorthand-clobbers-the-inline-axis trap
 *     to guard against.
 * What REPLACED them is the rail's own geometry seam (`__tests__/appsRailGeometry.test.ts`)
 * and the rendered rail in `AppsRailNav.browser.test.tsx`.
 *
 * The band's own claims — no rule, no vertical padding, the 16/32 proximity pair, and the
 * container never taking a per-page width — are unchanged and are what remains here.
 * This tier also runs in CI, which the browser project does not.
 */

const LAYOUT = path.resolve(__dirname, '../AppsPageLayout.tsx');
const RAIL = path.resolve(__dirname, '../AppsRailNav.tsx');
const layoutSrc = () => readFileSync(LAYOUT, 'utf8');
const railSrc = () => readFileSync(RAIL, 'utf8');

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
    expect(src).toMatch(/<Stack\s+gap="md"[\s>]/);
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
    expect(src).toMatch(/<Stack\s+gap="md"[\s>]/);
    // Parent gap: band -> page body. Was `lg` once; 20-vs-16 grouped nothing.
    expect(src).toMatch(/<Stack\s+gap="xl"[\s>]/);
    expect(src).not.toMatch(/<Stack\s+gap="lg"[\s>]/);
  });

  it('the layout Container drops its TOP pad but keeps a bottom one', () => {
    // Regression coverage for the vertical-padding pass: FAILS on pre-change
    // source, which carried `py="md"` (a 16px top pad under the global header).
    //
    // `pb` is asserted PRESENT, not merely "no py": this Container is the
    // outermost element on every `/apps/*` page, so its bottom pad is the only
    // thing keeping the last grid/table row off whatever follows. Dropping to a
    // bare `<Container size={…}>` would satisfy a "no py" check alone.
    const src = layoutSrc();
    expect(src).toMatch(/<Container\s+size=\{APPS_PAGE_CONTAINER_WIDTH\}\s+pb="md">/);
    expect(src).not.toMatch(/<Container[^>]*\bpy=/s);
    expect(src).not.toMatch(/<Container[^>]*\bpt=/s);
  });

  it('HORIZONTAL geometry is not overridden on the Container', () => {
    // INVARIANT GUARD — green before and after. Pins the thing successive passes
    // were explicitly not allowed to move, so a future "tighten the apps chrome"
    // edit can't quietly take the side gutters with it.
    const src = layoutSrc();
    expect(src).not.toMatch(/<Container[^>]*\b(px|pl|pr)=/s);
  });
});

/**
 * 🔴 THE CHROME SITS IN ONE CONTAINER, THE SAME ONE ON EVERY ROUTE.
 *
 * The defect these guards close: `AppsPageLayout` took a per-page container width
 * and rendered `AppsSubNav` INSIDE it, so the shared tab strip inherited each
 * page's width. Measured on a real render — nav left/width of 16/1408 on `/apps`,
 * 36/1368 on `/apps/review`, 76/1288 on the store preview, 186/1068 on
 * `/apps/submit` at 1440 — i.e. the one element required to be identical on every
 * apps page moved 170px horizontally between routes (410px at 2560).
 *
 * 🔴 WHY SOURCE GUARDS AS WELL AS THE PIXEL ONE. The rendered proof lives in
 * `AppsPageLayout.chromeAlignment.browser.test.tsx`, which is in the browser-mode
 * `component` project — REPORT-ONLY and non-blocking in CI, and red repo-wide for
 * an unrelated pre-existing failure. So it cannot block a regression on its own.
 * These run in the blocking `unit` project. They are the enforceable half.
 */
describe('AppsPageLayout takes NO per-page container width', () => {
  it('the Container width is the shared constant, not a prop', () => {
    const src = layoutSrc();
    // The state, not a keyword: the Container's `size` is THE shared constant.
    expect(src).toMatch(/<Container\s+size=\{APPS_PAGE_CONTAINER_WIDTH\}/);
    // …and it is the real import, not a same-named local.
    //
    // 🔴 THE BRACE LIST IS NOT PINNED, DELIBERATELY. This used to require
    // `{ APPS_PAGE_CONTAINER_WIDTH }` as the WHOLE import clause, so adding a second
    // symbol from the SAME module turned it red on a file that had not changed the
    // claim at all. The claim is "that identifier comes from that module"; anything
    // stricter is pinning the import's formatting.
    expect(src).toMatch(
      /import\s*\{[^}]*\bAPPS_PAGE_CONTAINER_WIDTH\b[^}]*\}\s*from\s*'~\/components\/Apps\/appsPageWidths'/s
    );
  });

  it('🔴 no `size` prop survives anywhere in the component', () => {
    // The regression is re-adding a caller-controlled width. Banned in every
    // spelling a caller could reach: the destructured param, the prop type, and
    // any `size={…}` on the Container.
    //
    // 🔴 SCOPED TO THE COMPONENT'S OWN SIGNATURE SINCE THE RAIL LANDED, AND THAT IS A
    // CORRECTION RATHER THAN A LOOSENING. The previous version banned `/^\s*size\s*=/m`
    // ANYWHERE in the file, which is a check on a SPELLING, not on the prop: the mobile
    // `<Drawer size="xs">` the rail added is an ordinary Mantine size on an unrelated
    // element and tripped it. A whole-file regex on a four-letter word cannot tell the
    // layout's own width prop from any other component's, so the destructuring and the
    // prop type are sliced out and checked directly.
    const src = layoutSrc();

    const sigStart = src.indexOf('export function AppsPageLayout({');
    expect(sigStart, 'the component signature was not found — re-point this guard').toBeGreaterThan(
      -1
    );
    const typeStart = src.indexOf('}: {', sigStart);
    const bodyStart = src.indexOf('}) {', typeStart);
    expect(typeStart, 'the prop-type block was not found').toBeGreaterThan(sigStart);
    expect(bodyStart, 'the component body was not found').toBeGreaterThan(typeStart);

    // The DESTRUCTURED PARAMETER LIST — `size` here (with or without a default) is the
    // exact shape that shipped the defect.
    const destructured = src.slice(sigStart, typeStart);
    expect(destructured).not.toMatch(/\bsize\b/);

    // The PROP TYPE — a declared `size?: …` a caller could pass.
    const propType = src.slice(typeStart, bodyStart);
    expect(propType).not.toMatch(/^\s*size[?]?:/m);

    // …and the Container never reads one.
    expect(src).not.toMatch(/<Container[^>]*size=\{size\}/s);
  });

  it('the measure never reaches the CONTAINER or the root stack', () => {
    // 🔴 THIS TEST DELIBERATELY NO LONGER CLAIMS "and left-aligned", AND THAT IS THE
    // FIX, not a weakening. It used to assert the exact tag
    // `<Box maw={measure}>{children}</Box>` and call the left-alignment ban "airtight".
    // It was not, in two independent ways, both of which passed the whole blocking suite:
    //
    //   • move that exact tag into a JSX COMMENT and render a bare `{children}` — the
    //     regex matches the comment, and the feature is dead;
    //   • leave that exact tag BYTE-IDENTICAL and wrap it in `<Center>` — no banned prop
    //     is on the Box, and the body renders centred.
    //
    // A source-text match cannot see either, because text does not care whether the code
    // runs or what encloses it. Both are now killed on the RENDERED tree in
    // `appsPageLayoutRender.test.ts`, which is in this same blocking project. What is
    // left here is the one claim source text CAN carry honestly: the measure is not
    // applied to the two elements that would take the chrome with it.
    const src = layoutSrc();
    expect(src).not.toMatch(/<Container[^>]*\b(maw|mx|w)=/s);
    expect(src).not.toMatch(/<Stack[^>]*\b(maw|mx|w)=/s);
  });

  it('the guard is reading a real file (not a silently-empty read)', () => {
    // Guard-the-guard: a renamed/moved file makes every `not.toMatch` above pass
    // vacuously, and the `toMatch`es above are what stop that going unnoticed.
    const src = layoutSrc();
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toMatch(/export function AppsPageLayout/);
    // `AppsMeasure` since the band pass — a number OR a `{min,max,grow}` band. The prop
    // still exists and is still the only width the caller controls, which is what this
    // guard-the-guard is for.
    expect(src).toMatch(/measure\?:\s*AppsMeasure/);
  });
});

describe('🔴 the rail draws NO rule of its own either', () => {
  // The replacement for the deleted `Tabs.List (the border owner)` guard, inverted. The
  // tab strip's bottom border was the ONE separator the band was allowed to rely on; a
  // vertical rail has no equivalent, so it must contribute none. A `border-right` on the
  // rail would be the natural way to re-introduce exactly the visual noise the double-rule
  // pass removed, one axis over.
  it('the rail file mentions no border at all', () => {
    const src = railSrc();
    expect(src).not.toMatch(/borderRight\s*:/);
    expect(src).not.toMatch(/border-right\s*:/);
    expect(src).not.toMatch(/borderInlineEnd\s*:/);
    expect(src).not.toMatch(/\bborder\s*:/);
    // …and it does not reach for the Tailwind spelling either, which an inline-style scan
    // cannot see.
    expect(src).not.toMatch(/className=[^\n]*\bborder-r\b/);
  });

  it('the guard is reading a real file (not a silently-empty read)', () => {
    // A missing/renamed file would make every `not.toMatch` above pass vacuously.
    const src = railSrc();
    expect(src.length).toBeGreaterThan(500);
    expect(src).toMatch(/export function AppsRailNavView/);
  });

  it('🔴 the rail is a `nav` LANDMARK carrying real anchors, not a tablist', () => {
    // Carried over from the tab strip, where the landmark had to be re-added by hand after
    // a Tabs conversion dropped it. The rail form makes it structural, and this is what
    // stops a future "make it a Tabs again" edit taking the landmark with it.
    const src = railSrc();
    expect(src).toMatch(/<nav\b[^>]*aria-label="App sections"/s);
    expect(src).not.toMatch(/<Tabs\b/);
    expect(src).toMatch(/<NextLink\b/);
  });
});
