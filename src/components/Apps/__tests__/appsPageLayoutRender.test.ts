import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AppsMeasure } from '~/components/Apps/appsPageWidths';

/**
 * `/apps` chrome — the measure box, asserted on the RENDERED TREE, in the tier that
 * actually gates.
 *
 * 🔴 WHY THIS FILE EXISTS: A SOURCE-TEXT GUARD IS WALKABLE BY A COMMENT.
 * The sibling `appsPageLayout.test.ts` pinned the measure box with
 * `expect(src).toMatch(/<Box\s+maw=\{measure\}>\{children\}<\/Box>/)`. That is a match
 * against the FILE'S TEXT, and text does not care whether the code runs. Both of these
 * passed the entire blocking suite while the feature was dead or wrong:
 *
 *   M2  move the `<Box maw={measure}>{children}</Box>` render into a JSX comment and
 *       render a bare `{children}` beside it
 *       → the regex still matches (inside a comment), `measure` is never applied, and
 *         `no-unused-vars` never fires because it is a destructured param followed by
 *         `children` (`args: after-used`), with `noUnusedLocals` unset.
 *
 *   M3  keep `<Box maw={measure}>{children}</Box>` BYTE-IDENTICAL and wrap it in
 *       `<Center>` → the exact-tag regex still matches, no banned prop is on the Box,
 *       and the body renders CENTRED — the precise thing the guard's own name
 *       ("left-aligned") claimed to prevent. That guard asserted a RELATIONSHIP in its
 *       title and inspected ONE SIDE in its body.
 *
 * Comments are not present in a rendered tree and a wrapper element is visible in it, so
 * both die here by construction rather than by a better-worded regex.
 *
 * 🔴 AND WHY IT IS IN THE BLOCKING `unit` PROJECT, NOT BESIDE THE PIXEL TEST.
 * `AppsPageLayout.chromeAlignment.browser.test.tsx` measures real pixels, but the
 * browser-mode `component` project is report-only in CI *and* currently red for reasons
 * unrelated to this code. A permanently-red non-blocking gate trains everyone to click
 * through it, so anything only it catches is effectively unguarded. This file runs in
 * `unit`, which is the tier whose verdict is read.
 *
 * Node env, so this is `renderToStaticMarkup` + happy-dom rather than a real browser —
 * which is enough for STRUCTURE (what contains what) though not for pixels. The two
 * files are deliberately complementary: structure here, geometry there.
 */

// The real nav needs a router, a session, feature flags and a tRPC query. None of that is
// what this file is about — only that the chrome renders and is NOT inside the measure
// box. Stubbing the DATA HOOK (rather than the rail component) keeps the real rail, the
// real `< 2` collapse and the real sticky wrapper in the tree, which is what the
// containment claims below are actually about.
//
// 🔴 TWO SECTIONS, NOT ONE. The layout hides the rail entirely below two
// (`APPS_NAV_MIN_SECTIONS`), so a one-section stub would render no `<nav>` at all and
// every "the measure box does not contain the chrome" assertion would pass vacuously.
vi.mock('~/components/Apps/useAppsNavSections', async () => {
  const registry = await import('~/components/Apps/apps-sections');
  return { useAppsNavSections: () => registry.appsSections.slice(0, 2) };
});

// `next/router` is not mocked globally in the node tier, and the rail reads
// `router.pathname` to decide which entry is current.
vi.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ pathname: '/apps' }),
}));

const { AppsPageLayout } = await import('~/components/Apps/AppsPageLayout');
const { APPS_PAGE_MEASURES, APPS_PAGE_CONTAINER_WIDTH, appsMeasureCss } = await import(
  '~/components/Apps/appsPageWidths'
);

/** Mantine emits `max-width:calc(<n/16>rem * var(--mantine-scale))` for `maw={n}`. */
const remOf = (px: number) => `${px / 16}rem`;

/**
 * The substring the rendered `max-width` must contain for a given measure.
 *
 * 🔴 TWO SHAPES, ONE ASSERTION. A numeric measure is converted to `rem` by Mantine; a
 * BAND is a `clamp(…)` string, which Mantine's `rem()` early-returns untouched. Reading
 * both through the module's own `appsMeasureCss` is deliberate — a second hand-written
 * copy of the formatter here would agree with itself while disagreeing with the layout.
 */
const expectedMaxWidth = (measure: AppsMeasure): string => {
  const css = appsMeasureCss(measure);
  return typeof css === 'number' ? remOf(css) : css;
};

type Tree = {
  /**
   * The measure box wrapping the page BODY, or `null` when there is no measure.
   *
   * 🔴 IDENTIFIED BY WHAT IT CONTAINS, not by document order. With a header present
   * there are TWO max-width boxes (the header band's and the body's), and
   * `querySelector` would hand back the header's — so every body assertion would
   * silently be about the wrong element.
   */
  measureBox: Element | null;
  /** The measure box wrapping the header band's title/actions, when both exist. */
  headerBox: Element | null;
  /** Every element carrying an inline max-width, in document order. */
  allBoxes: Element[];
  body: Element;
  nav: Element;
  title: Element | null;
  /** The `Stack gap="xl"` that holds the band and the body — the layout's own root stack. */
  rootStack: Element;
  /** The `Stack gap="md"` band that holds the nav and the header. */
  band: Element;
};

function renderLayout(measure?: AppsMeasure, withHeader = false): Tree {
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      { getRootElement: () => undefined },
      createElement(
        AppsPageLayout,
        {
          measure,
          ...(withHeader
            ? {
                title: 'A title',
                subtitle: 'A subtitle',
                actions: createElement('button', null, 'Act'),
              }
            : {}),
        },
        // Children as an ARGUMENT, not a prop (`react/no-children-prop`).
        createElement('div', { 'data-testid': 'body' }, 'body')
      )
    )
  );
  const window = new Window();
  const doc = window.document;
  doc.body.innerHTML = html;

  const body = doc.querySelector('[data-testid="body"]');
  const nav = doc.querySelector('nav[aria-label="App sections"]');
  if (!body || !nav) throw new Error('layout did not render its body and chrome');
  // 🔴 RESOLVED BY THE LAYOUT'S OWN `data-apps-chrome` MARKERS SINCE THE RAIL LANDED, NOT
  // BY WALKING UP FROM THE NAV. The nav used to be the band's first child, so `band =
  // nav.parentElement` and `rootStack = band.parentElement` worked. The nav is in a
  // SIBLING COLUMN now, so that walk would resolve the band to the rail's sticky wrapper
  // and the root stack to the `<aside>` — every assertion below would then be about the
  // wrong elements while still passing its own shape check, which is the worst failure
  // mode a structural test can have. The markers are read from the rendered tree, so a
  // renamed/removed one throws here rather than silently re-pointing.
  const band = doc.querySelector('[data-apps-chrome="band"]');
  const rootStack = band?.parentElement;
  if (!band || !rootStack) throw new Error('could not resolve the layout band / root stack');

  const allBoxes = Array.from(doc.querySelectorAll('[style*="max-width"]')) as unknown as Element[];
  const title = doc.querySelector('h2') as unknown as Element | null;

  return {
    // BY CONTAINMENT, not by order — see the note on the type.
    measureBox: allBoxes.find((b) => b.contains(body as unknown as Element)) ?? null,
    headerBox: (title && allBoxes.find((b) => b.contains(title))) || null,
    allBoxes,
    body: body as unknown as Element,
    nav: nav as unknown as Element,
    title,
    rootStack: rootStack as unknown as Element,
    band: band as unknown as Element,
  };
}

describe('the measure box, on the rendered tree', () => {
  it('the harness renders a real tree (guards a silently-empty parse)', () => {
    // Every assertion below is of the form "X contains Y" or "X does not contain Y", and
    // an empty parse makes the negative half pass vacuously. Pin that the pieces exist
    // and are distinct before trusting any containment answer.
    const t = renderLayout(1068);
    expect(t.body).toBeTruthy();
    expect(t.nav).toBeTruthy();
    expect(t.rootStack).toBeTruthy();
    expect(t.rootStack.contains(t.body)).toBe(true);
    expect(t.body).not.toBe(t.nav);
  });

  it('🔴 the chrome is in a DIFFERENT COLUMN from the page body — the rail change, structurally', () => {
    // ⚠️ INVERTED, AND THE INVERSION IS THE CHANGE. The line above used to read
    // `expect(t.rootStack.contains(t.nav)).toBe(true)`: the tab strip was the band's first
    // child, so the nav lived INSIDE the same stack as the body. The rail is a sibling
    // `<aside>`, so the nav must now be OUTSIDE that stack entirely — which is the
    // strongest form the original "the chrome is not inside a per-page width box" fix can
    // take, because there is no longer any box the body could grow that would reach it.
    const t = renderLayout(1068);
    expect(t.rootStack.contains(t.nav)).toBe(false);
    // …and both are still inside the ONE Container, so "different column" does not mean
    // "escaped the layout".
    const railRow = t.rootStack.parentElement?.parentElement;
    expect(railRow, 'the rail row was not found above the body column').toBeTruthy();
    expect(railRow!.getAttribute('data-apps-chrome')).toBe('row');
    expect(railRow!.contains(t.nav)).toBe(true);
    expect(railRow!.contains(t.body)).toBe(true);
  });

  it('🔴 M2 — a measure actually reaches the DOM as a max-width', () => {
    // Dies on the comment-out mutant: a commented-out `<Box>` renders nothing, so there
    // is no element carrying a max-width at all.
    const t = renderLayout(1068);
    expect(
      t.measureBox,
      'no element carries an inline max-width — the measure never rendered'
    ).not.toBeNull();
    expect(t.measureBox!.getAttribute('style')).toContain(remOf(1068));
  });

  it('🔴 M2 — the measure box CONTAINS the page body', () => {
    // A max-width box that renders but does not wrap `{children}` bounds nothing.
    const t = renderLayout(1068);
    expect(t.measureBox!.contains(t.body)).toBe(true);
  });

  it('🔴 the measure box does NOT contain the chrome — the whole point of the change', () => {
    // This is the defect the PR fixes, stated as containment: the sub-nav must sit
    // OUTSIDE any per-page width box, or it inherits that page's width and moves.
    const t = renderLayout(1068);
    expect(t.measureBox!.contains(t.nav)).toBe(false);
  });

  it('🔴 M3 — the measure box is a DIRECT CHILD of the root stack (no wrapper may centre it)', () => {
    // THE RELATIONSHIP, not one side of it. `<Center>` (or any centring wrapper) inserts
    // an element between the root stack and the measure box, so this fails structurally
    // — without naming `Center`, a class, or any style keyword a future wrapper could
    // spell differently. The root stack is a column flexbox with `align: stretch`, so a
    // direct-child max-width box is left-aligned by construction.
    const t = renderLayout(1068);
    // Named, because `toBe` on two DOM nodes prints "expected HTMLDivElement to be
    // HTMLDivElement", which tells a future reader nothing about what went wrong.
    const parentTag = t.measureBox!.parentElement?.getAttribute('class') ?? '(none)';
    const stackTag = t.rootStack.getAttribute('class') ?? '(none)';
    expect(
      t.measureBox!.parentElement === t.rootStack,
      `the measure box must be a DIRECT child of the layout root stack, but its parent ` +
        `is a different element (parent class="${parentTag}", root stack class="${stackTag}"). ` +
        `Something is wrapping it — a wrapper can centre the body, which breaks the ` +
        `left-alignment this layout guarantees.`
    ).toBe(true);
  });

  it('🔴 M3 — and the box does not centre ITSELF, by ANY carrier', () => {
    // The other side of the relationship: the wrapper route is closed above, this closes
    // centring applied to the box itself.
    //
    // 🔴 BOTH CARRIERS, NOT JUST INLINE STYLE. An earlier version checked only
    // `getAttribute('style')`, so `className="mx-auto"` — one Tailwind utility, the most
    // natural way anyone here would actually centre something — walked straight past it
    // while the isolated `mx="auto"` control died. A style-attribute check is a check on
    // ONE SPELLING of centring, and the docstring claimed to cover centring as such.
    //
    // ⚠️ WHAT THIS CANNOT DO, stated rather than implied: happy-dom resolves no
    // stylesheet here (none is loaded in the node tier), so `getComputedStyle` cannot
    // tell us the RESOLVED margin — a class's effect is invisible to it. So this asserts
    // the CARRIERS instead: the box may carry a max-width and nothing else. The resolved
    // geometry is asserted where a real engine can compute it, in
    // `AppsPageLayout.chromeAlignment.browser.test.tsx`, which checks on every route that
    // the body's left edge equals the nav's — that one catches any mechanism at all.
    const t = renderLayout(1068);
    const style = t.measureBox!.getAttribute('style') ?? '';
    expect(style).not.toMatch(/margin/i);
    // Only the cap may be present, so no `inset`/`transform`/`position` route either.
    expect(style.replace(/max-width:[^;]*;?/, '').trim()).toBe('');
    // No class may be carried at all — that is what closes the stylesheet route.
    expect(
      (t.measureBox!.getAttribute('class') ?? '').trim(),
      'the measure box carries a CSS class; a class can centre it and this tier cannot ' +
        'resolve stylesheets, so no class is permitted on it'
    ).toBe('');
  });

  it('without a measure, nothing bounds the body and it stays a direct child', () => {
    const t = renderLayout(undefined);
    expect(t.measureBox).toBeNull();
    expect(t.body.parentElement).toBe(t.rootStack);
  });

  it('the max-width tracks the value passed (a POSITIVE CONTROL on the assertion above)', () => {
    // Without this, `toContain(remOf(1068))` could be satisfied by a layout that hardcodes
    // 1068 and ignores its prop. Feed a value no real measure equals and watch it move.
    const odd = 777;
    expect(Object.values(APPS_PAGE_MEASURES)).not.toContain(odd);
    const t = renderLayout(odd);
    expect(t.measureBox!.getAttribute('style')).toContain(remOf(odd));
    expect(t.measureBox!.getAttribute('style')).not.toContain(remOf(1068));
  });

  it('every route measure renders its own distinct max-width', () => {
    const entries = Object.entries(APPS_PAGE_MEASURES) as [string, AppsMeasure][];
    // Guard-the-guard: an empty map would make the loop pass vacuously. Seven since
    // `/apps/review` gave up its cap and joined the full-container list.
    expect(entries.length).toBeGreaterThanOrEqual(6);
    const rendered = new Set<string>();
    for (const [route, measure] of entries) {
      const t = renderLayout(measure);
      expect(t.measureBox, `${route} rendered no measure box`).not.toBeNull();
      expect(t.measureBox!.getAttribute('style'), route).toContain(expectedMaxWidth(measure));
      rendered.add(t.measureBox!.getAttribute('style') ?? '');
    }
    // Two measure CLASSES, so two distinct rendered widths — proof the fixture varies
    // the dimension rather than feeding one value seven times.
    expect(rendered.size).toBe(2);
  });

  it('🔴 a BAND reaches the DOM as a clamp, not as a rem floor', () => {
    // The failure this catches is a measure that renders its `min` and stops growing —
    // which looks completely correct at 1440 and silently un-does the whole band on a
    // wide screen. `remOf(min)` must NOT be what lands in the attribute.
    const band = { min: 1068, max: 1368, grow: 55 } as const;
    const t = renderLayout(band);
    const style = t.measureBox!.getAttribute('style') ?? '';
    expect(style).toContain('clamp(1068px, 55%, 1368px)');
    expect(style).not.toContain(remOf(1068));
  });

  it('🔴 the HEADER is bounded by the same measure as the body', () => {
    // The audit finding this closes: the header band sits OUTSIDE the body's measure box,
    // so with the body alone bounded, a measured page's title/subtitle stretched to the
    // full container — /apps/submit's real subtitle laid out at 1224.13px against a 1068
    // measure. "Only the chrome moved" is only true if BOTH are bounded.
    const t = renderLayout(1068, /* withHeader */ true);
    expect(t.title, 'the header did not render').not.toBeNull();
    expect(t.headerBox, 'the header is not inside any max-width box').not.toBeNull();
    expect(t.headerBox!.getAttribute('style')).toContain(remOf(1068));
  });

  it('🔴 the header box and the body box share the SAME measure (one helper, not two)', () => {
    // A RELATIONSHIP, not two independent facts: the failure this catches is the two call
    // sites drifting to different numbers, which no single-sided assertion would see.
    const t = renderLayout(1368, true);
    expect(t.headerBox!.getAttribute('style')).toBe(t.measureBox!.getAttribute('style'));
    // …and they are genuinely two different elements, so the equality is not trivial.
    expect(t.headerBox).not.toBe(t.measureBox);
  });

  it('🔴 the header box still does NOT contain the chrome', () => {
    // Bounding the header must not have swept the sub-nav in with it — that would be the
    // original defect, re-introduced one level down.
    const t = renderLayout(1068, true);
    expect(t.headerBox!.contains(t.nav)).toBe(false);
    // The header box is a direct child of the band…
    expect(t.headerBox!.parentElement).toBe(t.band);
    // …and the nav is not in the band at all any more. It was a SIBLING of the header box
    // inside the band while the chrome was a tab strip; as a rail it is in the other
    // column, so the containment claim strengthens from "not inside the box" to "not
    // inside the band".
    expect(t.band.contains(t.nav)).toBe(false);
  });

  it('🔴 neither measure box can shift the band vertically', () => {
    // WHY THIS IS HERE RATHER THAN IN THE PIXEL TEST: the vertical pins in
    // `AppsPageLayout.geometry.browser.test.tsx` render a header with NO measure, so they
    // are structurally blind to the box this change adds inside the band — and that file
    // is in the report-only tier anyway. The mechanism that keeps the 16px/32px grouping
    // intact is that these wrappers contribute no box model of their own, which IS
    // checkable here, in the blocking tier.
    const t = renderLayout(1068, true);
    for (const [name, box] of [
      ['header', t.headerBox],
      ['body', t.measureBox],
    ] as const) {
      const style = box!.getAttribute('style') ?? '';
      expect(style, `${name} box must not pad`).not.toMatch(/padding/i);
      expect(style, `${name} box must not margin`).not.toMatch(/margin/i);
      // Only the cap, nothing else.
      expect(style.replace(/max-width:[^;]*;?/, '').trim()).toBe('');
      // …and no class, which is the other carrier that could pad, margin or centre it.
      expect((box!.getAttribute('class') ?? '').trim(), `${name} box must carry no class`).toBe('');
    }
  });

  it('with a header but NO measure, nothing is bounded (the band is untouched)', () => {
    // The measure-free pages are the majority and their band must render exactly as it
    // did before this change — the vertical geometry pins depend on it.
    const t = renderLayout(undefined, true);
    expect(t.allBoxes).toHaveLength(0);
    expect(t.title!.parentElement?.parentElement?.parentElement).toBe(t.band);
  });

  it('the container width is the shared constant on every render', () => {
    // `--container-size` is what Mantine emits for `<Container size={n}>`. Asserted here
    // on the RENDERED tree so a per-page container cannot come back via a code path the
    // source regexes do not read.
    // 🔴 THE WALK IS TWO LEVELS LONGER SINCE THE RAIL LANDED: root stack → body column →
    // rail row → Container. Resolved by climbing to the `data-apps-chrome="row"` marker
    // and taking its parent, rather than by a fixed number of `.parentElement` hops, so a
    // future wrapper fails loudly here instead of silently reading an inner div's style.
    for (const measure of [undefined, 1068, 1368]) {
      const t = renderLayout(measure);
      let node: Element | null = t.rootStack;
      while (node && node.getAttribute('data-apps-chrome') !== 'row') node = node.parentElement;
      expect(node, 'the rail row was not found above the root stack').not.toBeNull();
      const container = node!.parentElement;
      expect(container?.getAttribute('style') ?? '').toContain(remOf(APPS_PAGE_CONTAINER_WIDTH));
    }
  });
});
