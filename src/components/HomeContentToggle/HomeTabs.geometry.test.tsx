/**
 * THE SUB NAV TAB ROW IS REACHABLE AT EVERY WIDTH — MEASURED IN PIXELS.
 *
 * The defect: the row is content-width and never collapses (`useResolvedNav` derives the bar/More
 * split from saved config, not the viewport), so it measured a fixed ~1334px signed in at every
 * width from 1024 to 1400 (measured 2026-09-15). `@md:overflow-visible` overrode BOTH overflow axes above the `md`
 * container breakpoint, so above 1024 the row could not scroll and an ancestor `overflow-hidden`
 * clipped "Shop" and "More" out of reach. `document.scrollWidth` stayed equal to the viewport the
 * whole time, which is why no page-level check found it.
 *
 * WHY THIS TIER. The sibling source gate pins the class list, and a class list is a spelling.
 * Measured by mutation: `@md:overflow-visible` and `md:overflow-visible` switch at the identical
 * 1024px — `screens` and `containers` both come from `breakpoints.json` — and produce the identical
 * dead band, so any guard that enumerates variant prefixes catches one and misses the other. This
 * file asserts the CONSEQUENCE instead: the row is a real scroller and the ring fits. That holds
 * under every spelling, including the container-query one that shipped the defect — see `Shell`,
 * without which this file is blind to exactly that class. It also catches causes no class list can
 * express: a `style={{}}` override, a CSS-module rule, or an ancestor's clip.
 *
 * It cannot be written in the `component` tier: that tier loads 24 CSS rules and no Tailwind, so
 * `overflow-x-auto` computes to the INITIAL value `visible` there and an assertion of "not visible"
 * would pass against a completely broken row. See `test/geometry-setup.tsx`.
 */
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { MantineProvider } from '@mantine/core';
import { cascadeEvidence, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import type * as TrpcModule from '~/utils/trpc';

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({
    articles: true,
    bounties: true,
    comicCreator: true,
    challengePlatform: true,
    cosmeticShop: true,
    model3dFeed: true,
    userHubs: true,
    auctions: true,
    vault: true,
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/components/UserSettings/hooks', () => ({ useCurrentUserSettings: () => ({}) }));
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/leaderboard/[id]', asPath: '/' }),
}));
// `...actual` is the real module, so a new export cannot silently become `undefined`. `trpc` itself
// is REPLACED rather than spread: `createTRPCNext` returns a flat Proxy over a function, which has
// no own enumerable keys, so `{ ...actual.trpc }` copies nothing and would only look like a merge.
// `HomeTabs` reaches for exactly one procedure; a second one fails loudly on `undefined.useQuery`.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return { ...actual, trpc: { changelog: { getLatest: { useQuery: () => ({ data: 0 }) } } } };
});

const { HomeTabs } = await import('./HomeContentToggle');

/**
 * 🔴 THE `@container` WRAPPER IS NOT DECORATION — WITHOUT IT THIS FILE CANNOT SEE THE BUG.
 *
 * `@md:overflow-visible`, the class that shipped the defect, is a CONTAINER query: Tailwind
 * compiles it to `@container (min-width: …)`, which is FALSE when no ancestor establishes a query
 * container. The harness providers are `QueryClientProvider` + a bare `MantineProvider`, so a row
 * rendered directly under them never matches it. Measured: with `@md:overflow-visible` back on the
 * row and no wrapper, this file reported every test passing, exit 0.
 *
 * In production the container is `ScrollArea` (`'scroll-area flex-1 @container'`) and the clip
 * comes from an ancestor's `overflow-hidden` — which is also why the page never grew a scrollbar
 * while the tabs were unreachable. Both are reproduced here.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden">
      <div className="@container">
        {/* 🔴 The harness's own provider is a BARE `<MantineProvider>` (`test/geometry-setup.tsx`),
            so none of `ThemeProvider`'s defaults reach it — including
            `Popover: { defaultProps: { withinPortal: false } }`, which `Menu` inherits. Without
            this nested provider the More menu PORTALS in here while it renders inline in the app,
            and the reachability test below cannot see a clipped dropdown at all: measured
            2026-09-15, it reported 8 passed with `relative` planted on the row. */}
        <MantineProvider
          theme={{ components: { Popover: { defaultProps: { withinPortal: false } } } }}
        >
          {children}
        </MantineProvider>
      </div>
    </div>
  );
}

/** The scrolling row itself — the element every assertion below is about. */
function tabRow(): HTMLElement {
  const anchor = document.querySelector('a[href="/models"]');
  if (!anchor?.parentElement)
    throw new Error('tab row not found — HomeTabs rendered no /models pill');
  return anchor.parentElement;
}

/** The More menu's trigger — by its label, since `data-testid` is stripped from production. */
function moreButton(): HTMLElement {
  const found = [...tabRow().querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').trim().startsWith('More')
  );
  if (!found) throw new Error('More button not rendered — check the feature-flag mock');
  return found as HTMLElement;
}

/**
 * The ring Mantine draws OUTSIDE an element's border box: outline-width + outline-offset.
 *
 * The ring only exists while the element is focused, so this focuses before reading — an
 * unfocused element reports the initial `outline-width: 0`. `focusVisible` asks for the visible
 * ring explicitly rather than relying on the heuristic; measured, a plain `.focus()` also yields
 * 4px here, so it is intent, not a workaround.
 *
 * 🔴 The caller asserts this is nonzero BEFORE the containment checks, and that ordering is the
 * load-bearing part: at 0 the inflated rect IS the rect, so every containment assertion compares
 * a box against itself and passes against a row with no padding at all. Do not remove the nonzero
 * assertion as redundant — it is what makes an unexpected 0 loud instead of silent.
 */
function ringInk(el: HTMLElement): number {
  // `preventScroll` because focusing scrolls the element into view by default, which would move
  // the very rects the caller is about to compare.
  el.focus({ focusVisible: true, preventScroll: true } as FocusOptions);
  const s = getComputedStyle(el);
  return (parseFloat(s.outlineWidth) || 0) + (parseFloat(s.outlineOffset) || 0);
}

describe('sub nav tab row geometry', () => {
  test('the real cascade is loaded — without this every assertion below is vacuous', async () => {
    const { observed } = await renderAtViewport(
      <Shell>
        <HomeTabs />
      </Shell>,
      { width: 1136, height: 800 }
    );
    expect(observed).toEqual({ width: 1136, height: 800 });

    // `overflow-x-auto` computing to `auto` is only meaningful if Tailwind is actually present:
    // an unstyled element reports the INITIAL value for most of what this file reads. Assert a
    // fact that is false without the stylesheet before asserting anything about the row.
    const evidence = cascadeEvidence();
    expect(evidence.tailwindFlexUtilityResolves).toBe(true);
    expect(evidence.ruleCount).toBeGreaterThan(1000);
  });

  test('is a horizontal scroller whose content is reachable at 1136px', async () => {
    await renderAtViewport(
      <Shell>
        <HomeTabs />
      </Shell>,
      { width: 1136, height: 800 }
    );
    await nextLayout();
    const row = tabRow();

    // The bug: `overflow-x` computed `visible`, so the row rendered at full content width and was
    // clipped by an ancestor with no way to scroll.
    expect(getComputedStyle(row).overflowX).toBe('auto');
    // That this OVERFLOWS at 1136 is a property of the fixture — nine flags on and no saved config
    // give a ~1334px row (2026-09-15). If a future default nav ships fewer tabs this reddens here,
    // which is the fixture going stale rather than the row breaking.
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);

    // The scroll actually moves: a clamped assignment would leave this at 0, and then a later
    // reachability claim would be about a row that never scrolled.
    row.scrollLeft = row.scrollWidth;
    await nextLayout();
    // Not exact equality: `scrollWidth`/`clientWidth` are rounded integers while Chromium's scroll
    // offset can be fractional, and a sub-pixel difference here would read as a code regression.
    expect(row.scrollLeft).toBeCloseTo(row.scrollWidth - row.clientWidth, 0);
  });

  test.each([1200, 1500])('stays a scroller at %ipx', async (width) => {
    // The sibling source gate is a class list, and a class list is a spelling; this file is the
    // half that measures. But a single measurement point is its own blind spot — `lg:` variants
    // (1184px) are not live at 1136, so a `lg:`-prefixed override would pass a 1136-only check.
    await renderAtViewport(
      <Shell>
        <HomeTabs />
      </Shell>,
      { width, height: 800 }
    );
    await nextLayout();
    expect(getComputedStyle(tabRow()).overflowX).toBe('auto');
  });

  test('shrinks so the feed filters keep their place on the same line', async () => {
    // NAMED FOR THE DECISION: Justin asked (2026-09-15) for the filters and the settings gear to
    // stay on one line with the tabs, and for the tab row to scroll earlier instead of pushing
    // them to a second row.
    //
    // `flex-1` is what delivers that, and the wrapper here must ALLOW WRAPPING or this test
    // cannot see it. `SubNav2` wraps, and a wrapping container places items at their FLEX BASIS
    // before it shrinks anything: at `basis: auto` the row's basis is its ~1334px content, which
    // does not fit, so the sibling wraps. `flex-1` sets `basis: 0`, so both fit on the line and
    // the row then shrinks into what is left. Under `flex-nowrap` nothing wraps whatever the
    // basis is, and this test passed against a reverted `flex-1` — measured 2026-09-15.
    //
    // `min-w-0` is deliberately NOT on the row. A flex item's automatic minimum size would
    // normally stop it shrinking below its content, but `overflow-x: auto` already zeroes that,
    // so the class is redundant here — removing it changed nothing at any of eight widths.
    const FILTERS_WIDTH = 402;
    await renderAtViewport(
      <Shell>
        <div className="flex flex-wrap items-start" data-row-under-test>
          <HomeTabs />
          <div style={{ width: FILTERS_WIDTH, flexShrink: 0, height: 36 }} data-filters />
        </div>
      </Shell>,
      { width: 1136, height: 800 }
    );
    await nextLayout();
    const row = tabRow();
    const line = row.parentElement as HTMLElement;
    const filters = line.querySelector('[data-filters]') as HTMLElement;

    // The row gave way rather than the sibling: it is narrower than its own content, and narrow
    // enough to leave the sibling its full width on the same line.
    expect(row.clientWidth).toBeLessThan(row.scrollWidth);
    expect(filters.getBoundingClientRect().width).toBe(FILTERS_WIDTH);
    expect(filters.getBoundingClientRect().right).toBeLessThanOrEqual(
      line.getBoundingClientRect().right + 1
    );
    // Same line, not merely both present — the whole point of the change.
    expect(Math.round(filters.getBoundingClientRect().top)).toBe(
      Math.round(row.getBoundingClientRect().top)
    );
  });

  test('keeps the More button from being squashed by that shrink', async () => {
    // The fix above passes shrink pressure to the row's children, and More is the one that gives:
    // measured 2026-09-15 before `shrink-0`, it collapsed to an empty 28px circle with its label
    // squeezed away, which is what Justin saw and reported. `textContent` reads "More" in both
    // states — the text is still in the DOM — so the width is what separates them.
    //
    // Compared against its OWN unpressured width rather than a threshold. A constant would be
    // tuned to this box's fonts while the fixed state (~87px) is font-dependent and the squashed
    // one (~28px) is nearly not, so the margin differs per machine. This needs no number.
    // Wide enough that the row does NOT overflow, so nothing is shrinking. At 1136 the row
    // overflows on its own and More is already squashed without the sibling — measured, that made
    // an earlier version of this comparison pass against a reverted `shrink-0`, both sides 28px.
    await renderAtViewport(
      <Shell>
        <div className="flex flex-wrap items-start">
          <HomeTabs />
        </div>
      </Shell>,
      { width: 1600, height: 800 }
    );
    await nextLayout();
    const relaxedRow = tabRow();
    expect(relaxedRow.scrollWidth).toBeLessThanOrEqual(relaxedRow.clientWidth);
    const relaxed = moreButton().getBoundingClientRect().width;
    // AWAITED because this one sits BETWEEN two renders: `cleanup()` returns a promise and unmounts
    // via `act`, and `tabRow()` resolves by document selector, so an unawaited teardown leaves the
    // first render in the document and both reads below land on it instead of the pressured row.
    await cleanup();

    await renderAtViewport(
      <Shell>
        <div className="flex flex-wrap items-start">
          <HomeTabs />
          <div style={{ width: 402, flexShrink: 0, height: 32 }} />
        </div>
      </Shell>,
      { width: 1136, height: 800 }
    );
    await nextLayout();
    const row = tabRow();
    // The premise. Without this the test can pass by the row never having been squeezed at all —
    // if the pills ever start absorbing the shortfall first, it would keep passing while having
    // stopped measuring `shrink-0`.
    expect(row.clientWidth).toBeLessThan(row.scrollWidth);
    // Against a PILL **and** against the number. Parity alone is not enough: deleting `h-8` from
    // both the pills and More — or moving both to `h-9`, which is the likelier edit — leaves them
    // equal at Mantine's `size="sm"` 36px and grows the bar 4px on every page. Parity catches the
    // one-sided change, the literal catches the two-sided one, so keep both.
    const firstPill = row.children[0] as HTMLElement;
    // Or the assertion is `x === x`: with an empty `bar`, child zero IS the More button.
    expect(firstPill).not.toBe(moreButton());
    const pillHeight = firstPill.getBoundingClientRect().height;
    expect(pillHeight).toBeCloseTo(32, 1);
    expect(moreButton().getBoundingClientRect().height).toBeCloseTo(pillHeight, 1);
    // The font is not pinned in CSS any more — `.moreButton` dropped its `font-size`/`font-weight`
    // because a Mantine `size="sm"` Button already produces 14px/600. That makes this the only
    // thing standing between the two controls and a silent typographic divergence.
    const labelFont = (el: Element) => {
      const s = getComputedStyle(el);
      return `${s.fontSize}/${s.fontWeight}`;
    };
    expect(labelFont(moreButton())).toBe(labelFont(firstPill));
    // Precision 1 (±0.05), not 2 (±0.005): Chromium quantises rects to 1/64px = 0.0156, so a
    // single LayoutUnit of drift would fail the tighter one, and ±0.05 still separates the
    // squashed ~28px from the fixed width by three orders of magnitude.
    expect(moreButton().getBoundingClientRect().width).toBeCloseTo(relaxed, 1);
  });

  test('keeps the More menu reachable — a clipped dropdown has the same rect as a working one', async () => {
    // NAMED FOR THE TRAP. The block comment in the sibling source gate forbids `relative`,
    // `position: sticky`, `@container`, `transform`, a `filter` and `will-change` on this row,
    // because the More dropdown is not portalled: its containing block is the sticky
    // subnav ABOVE the scroller, and any of those properties moves it INSIDE, where
    // `overflow-x: auto` clips it at every width.
    //
    // 🔴 This is the only assertion that can see that. Measured 2026-09-15 by wrapping the button
    // in a sticky element: the dropdown's rect was byte-identical with and without the fault —
    // same x, y, width, height — while its item went from hit-testable to not. So a rect
    // assertion and a `textContent` assertion BOTH pass against the broken state. Until this test
    // existed, adding `relative` to the row passed both tiers green.
    await renderAtViewport(
      <Shell>
        <HomeTabs />
      </Shell>,
      { width: 1136, height: 800 }
    );
    await nextLayout();
    const row = tabRow();
    const hit = (el: Element) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    };

    // The original report was that MORE ITSELF could not be clicked, so start there. At 1136 it
    // sits past the row's right edge and is NOT hit-testable — that is the design Justin chose
    // (More scrolls off rather than pinning), so the invariant is "reachable BY SCROLLING", which
    // is exactly what the defect denied. Assert both halves: unreachable before, reachable after.
    // The premise, so a stale fixture reads as a stale fixture: More is off the end because the
    // row overflows, not because it vanished.
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
    expect(moreButton().getBoundingClientRect().left).toBeGreaterThan(
      row.getBoundingClientRect().right
    );
    expect(hit(moreButton())).toBe(false);
    row.scrollLeft = row.scrollWidth;
    await nextLayout();
    expect(hit(moreButton())).toBe(true);

    moreButton().click();
    await nextLayout();
    await nextLayout();

    const dropdown = document.querySelector('.mantine-Menu-dropdown');
    if (!dropdown) throw new Error('More menu did not open — nothing to hit-test');
    const item = dropdown.querySelector('a, button');
    if (!item) throw new Error('More menu opened with no items — check the feature-flag mock');

    // 🔴 POSITIVE CONTROL for `Shell`'s nested provider. Everything below is about a dropdown
    // rendered INSIDE the clipping box; if the harness portals it to `<body>` instead it escapes
    // every clip and the hit-test passes against a planted `relative`. Not hypothetical — that is
    // how the first version of this test failed. Delete the provider and this reddens first.
    expect(tabRow().contains(dropdown)).toBe(true);

    expect(item.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(hit(item)).toBe(true);
  });

  test('pays enough padding for the focus ring on the scroll axis', async () => {
    await renderAtViewport(
      <Shell>
        <HomeTabs />
      </Shell>,
      { width: 1136, height: 800 }
    );
    await nextLayout();
    const row = tabRow();
    const clip = row.getBoundingClientRect();

    // `overflow-y` cannot be `visible` beside `overflow-x: auto`, so the row clips on both axes,
    // and an outline contributes no scrollable overflow — a clipped ring cannot be scrolled into
    // view. The end children are the ones at risk.
    row.scrollLeft = 0;
    await nextLayout();
    const first = row.children[0] as HTMLElement;
    const firstRect = first.getBoundingClientRect();
    const firstInk = ringInk(first);
    // 🔴 Before the containment checks, and load-bearing: at ink 0 the inflated rect IS the rect,
    // so every containment assertion compares a box against itself. Do not delete as redundant.
    expect(firstInk).toBeGreaterThan(0);
    expect(firstRect.left - firstInk).toBeGreaterThanOrEqual(clip.left);
    // HORIZONTAL ONLY, deliberately — the why is on the row itself in `HomeContentToggle.tsx`.
    // This is the axis that scrolls, and an outline contributes no scrollable overflow, so a ring
    // clipped here is unreachable outright rather than merely cut.

    row.scrollLeft = row.scrollWidth;
    await nextLayout();
    const last = row.children[row.children.length - 1] as HTMLElement;
    // By identity, not by index. Under this mock `more` resolves to exactly `['bounties']`; drop
    // that flag later and the More button never renders, the last child silently becomes the Shop
    // pill, and every assertion here still passes having stopped measuring the control the fix is
    // for. `data-testid` would be stripped from production builds, so match the label instead.
    expect(last.textContent).toContain('More');
    const lastInk = ringInk(last);
    // Same guard as `firstInk`, and for the same reason. `last` is the More menu's trigger, whose
    // focus goes through Mantine's ref forwarding and is the likeliest of the two to be rewrapped
    // later — at ink 0 the assertion below degenerates into one test 2 already makes.
    expect(lastInk).toBeGreaterThan(0);
    // The invariant stated directly: the padding is at least the ink, on each side. An earlier
    // version compared the last child's right edge after `scrollLeft = scrollWidth`, which needed
    // a 1px tolerance — `scrollLeft` clamps to an integer while the content width is fractional,
    // leaving a sub-pixel remainder — and that tolerance silently accepted an underpay of up to
    // 0.7px. It was also calibrated at a row width production never renders, since `flex-1` is
    // inert under this file's block-level wrapper. Reading the padding has neither problem and
    // reddens on `px-[3.5px]` as well as on `px-0`.
    const padding = getComputedStyle(row);
    expect(parseFloat(padding.paddingLeft)).toBeGreaterThanOrEqual(firstInk);
    expect(parseFloat(padding.paddingRight)).toBeGreaterThanOrEqual(lastInk);
  });
});
