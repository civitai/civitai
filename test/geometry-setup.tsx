/**
 * GEOMETRY HARNESS — the `geometry` Vitest project's setup file.
 *
 * A second browser-mode project that renders against the REAL app cascade at an
 * EXPLICIT viewport, so a test can assert PIXELS rather than attributes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE GAP ACTUALLY IS — AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE `component` PROJECT IS A REAL BROWSER WITH A REAL LAYOUT ENGINE. It runs
 * headless Chromium through `@vitest/browser-playwright`, `page.viewport()`
 * genuinely moves `window.innerWidth/Height` there, and `getBoundingClientRect()`
 * returns real non-zero boxes. Anyone arriving here expecting "the component tier
 * is jsdom, so it cannot lay out" should stop: that is false for this repo, and
 * a harness justified on it would be solving a problem that does not exist.
 *
 * What that tier is missing is the STYLESHEET and the VIEWPORT:
 *
 *   · `test/component-setup.tsx` parses the `:root` custom properties out of
 *     `globals.css` and injects ONLY those — measured, the document holds 24 CSS
 *     rules. So every Mantine class is styleless, every Tailwind utility is inert
 *     (`className="flex"` computes `display: block`), and a `var(--mantine-*)`
 *     written by a stylesheet is simply absent. A real layout engine with no
 *     stylesheet still cannot measure the real layout: it measures a DIFFERENT,
 *     internally-consistent one, which is worse than measuring nothing.
 *   · nothing sets a viewport, so every file inherits the runner's silent default.
 *
 * The consequence is the same either way and it is the thing to hold on to: a
 * `getComputedStyle` assertion whose expected value happens to be the CSS INITIAL
 * value (`nowrap`, `visible`, `static`, `auto`, `none`, `0px`) passes against a
 * broken component, because an unstyled element reports exactly those. And the
 * layout DECISION is testable without any of this — `data-layout="stacked"` is an
 * attribute — which is the trap: a suite can pin every decision correctly and
 * still ship the wrong sizing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND PROJECT, GIVEN THE CHEAPER OPTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * Two cheaper options exist and both were weighed:
 *
 * (a) LOAD THE CASCADE IN THE SHARED SETUP. Rejected. `component-setup.tsx`'s own
 *     header records that importing the real cascade changes the rendered geometry
 *     of existing tests, and that is not a guess — measured here, the SAME chrome
 *     bar is 200px with the shared setup and 31px with the cascade loaded, a 169px
 *     move on one element. 212 files / 2,362 tests run in that tier, 14 of them
 *     reading `getBoundingClientRect` and 20 reading `getComputedStyle`. Changing
 *     the cascade under all of them is a suite-wide rewrite, not a fix.
 *
 * (b) IMPORT THE STYLESHEET PER FILE. This already exists — 15 of the 212 browser
 *     test files import a Mantine stylesheet themselves and 3 also import
 *     `~/styles/globals.css` — and it stays available; nothing here deprecates it.
 *     What it does not give you is a GUARANTEE. Each of those files chose its own
 *     subset (7 take unlayered `@mantine/core/styles.css`, 2 take the layered
 *     variant the app actually ships), none declares the `@layer` ORDER that
 *     `_document.tsx` puts first in `<head>`, none sets a default viewport, and
 *     the "did my stylesheet actually load" guard has been re-hand-rolled per file
 *     (`assertLayoutIsReal` in `AppListingCard.browser.test.tsx` is one copy).
 *     A project makes the cascade, the viewport and the controls properties of the
 *     TIER rather than of whoever remembered.
 *
 * So the cascade lands in a NEW project with a NEW glob, and nothing that runs
 * today changes — verified: the full `component` tier is 212 files / 2,362 tests
 * passed, before and after. Vitest browser mode gives each test FILE its own
 * iframe, so the two setups cannot leak into one another even when both run.
 *
 * 🔴 THE SAME FIXTURE, THE SAME CORRECT SOURCE, MEASURED IN BOTH TIERS
 * (`PageBlockHost` in its production shell chain, 2026-09-03):
 *
 *                             `component`      `geometry`
 *   viewport                    414 x 896       390 x 844   (default vs set)
 *   CSS rules in the document          24           3,677
 *   box-sizing on a bare div  content-box      border-box
 *   `className="flex"`              block            flex
 *   chrome bar height                 200              31
 *   host frame height                 350             844
 *   APP COLUMN HEIGHT                 150             813
 *
 * That last row is the whole argument. `150` is ALSO what the app column
 * measures in this harness when the recorded `flex: 1` defect is planted — so an
 * assertion written in the `component` tier would have to expect the number the
 * DEFECT produces, and could not tell the two apart at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VIEWPORT IS SET AND THEN OBSERVED
 * ─────────────────────────────────────────────────────────────────────────────
 * The runner's default is **414 x 896** (measured 2026-09-03 against this repo's
 * pinned Vitest 4.1.11 / Playwright provider, `devicePixelRatio: 1`). Note that
 * it is a DEFAULT, not "unset": a suite that never calls `page.viewport()` is
 * measuring 414px and does not say so, and the number is a property of the
 * runner rather than of anything in this repo — a Vitest or Playwright bump can
 * move it and no assertion would notice.
 *
 * `renderAtViewport` therefore SETS the viewport and then THROWS unless the
 * window reports back the size it asked for. Tests are still expected to assert
 * `observed` against a literal of their own — trusting a config is what produced
 * the vacuous pass this harness exists to remove.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHAT RUNS THIS: THE `Geometry tests` JOB — AND IT IS REPORT-ONLY ON A PR.
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THIS PARAGRAPH SAID "NOTHING RUNS THIS, SAY IT OUT LOUD" AND HAD STOPPED BEING
 * TRUE. `.github/workflows/lint.yml` now carries a `geometry:` job (`Geometry tests`)
 * that installs Chromium and runs `vitest run --project geometry`, plus a collected-
 * count ledger so a selector that matches nothing fails instead of exiting 0. It is
 * observable on any PR's check list. Left uncorrected, the sentence would have talked
 * the next reader out of relying on a gate that exists — the mirror image of the rot it
 * was written to prevent.
 *
 * What is still true, and is the part that matters when you read a green check:
 * the job carries `continue-on-error: ${{ github.event_name == 'pull_request' }}`, so
 * on a PR it REPORTS and on a push to `main` it BLOCKS. Do not write "the blocking
 * tier" about this project without that qualifier.
 *
 * `component` is still ungated: no project selector in that workflow matches it, and
 * its only CI home is the preview pipeline's report-only `preview / component-tests`.
 *
 * `pnpm run test:geometry` is still the whole command locally, and the glob is
 * disjoint from every other project's, so adding a file here cannot change what any
 * other job runs.
 */

// ── THE CASCADE, IN PRODUCTION ORDER ─────────────────────────────────────────
// Mirrors `src/pages/_document.tsx` (the layer-order declaration) followed by
// the stylesheet imports at the top of `src/pages/_app.tsx`, in that file's
// order. Import order IS the contract here — see `cascade-layer-order.css`.
import './cascade-layer-order.css';
import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
import '@mantine/dates/styles.layer.css';
import '@mantine/dropzone/styles.layer.css';
import '@mantine/notifications/styles.layer.css';
import '@mantine/nprogress/styles.layer.css';
import '@mantine/tiptap/styles.layer.css';
import 'mantine-react-table/styles.css';

import React from 'react';
import { afterEach, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render, cleanup } from 'vitest-browser-react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * A phone. 390x844 is the iPhone 12/13/14/15 portrait logical viewport and the
 * modal phone width in this app's own RUM.
 *
 * 🔴 IT IS DELIBERATELY NOT THE RUNNER'S 414x896 DEFAULT. Two reasons, and the
 * second is the point of the harness. 414 sits ABOVE the 390/393 band most
 * phones report, so a `min-width` breakpoint or a flex floor that misbehaves
 * between 360 and 400 is invisible at the default; and a number the harness
 * merely inherited cannot be asserted against, because there is nothing to
 * compare it to that would not move with it.
 */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/** A narrow phone — the low end of the band, for a second measurement point. */
export const NARROW_PHONE_VIEWPORT = { width: 360, height: 780 } as const;

export type Viewport = { readonly width: number; readonly height: number };

// ─────────────────────────────────────────────────────────────────────────────
// Environment stubs.
//
// 🔴 DELIBERATELY A COPY OF `component-setup.tsx`'s STUBS, NOT AN IMPORT OF IT.
// Importing that module would re-run its `:root` extraction and inject a SECOND
// `:root` block on top of the real cascade — the one thing this harness exists
// to avoid. Factoring the stubs into a third shared module was rejected because
// `vi.mock` is hoisted PER MODULE by the Vitest transform, so moving the call
// changes when it registers; that is a behaviour change to the 484-test tier
// bought for a few lines of de-duplication. The two setups are expected to
// diverge on the cascade and to agree on the stubs; if you change one stub here,
// change it there.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('next/router', () => {
  const router = {
    push: vi.fn().mockResolvedValue(true),
    replace: vi.fn().mockResolvedValue(true),
    prefetch: vi.fn().mockResolvedValue(undefined),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    beforePopState: vi.fn(),
    query: {},
    pathname: '/',
    asPath: '/',
    route: '/',
    basePath: '',
    isReady: true,
    isFallback: false,
    isPreview: false,
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  };
  return {
    __esModule: true,
    useRouter: () => router,
    Router: router,
    default: router,
    withRouter: (Component: React.ComponentType) => Component,
  };
});

Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  },
});

// `cleanup()` is ASYNC and the hook MUST await it — the same container-race that
// `component-setup.tsx` documents at length applies here unchanged.
afterEach(async () => {
  await cleanup();
});

function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>
  );
}

/** Two frames, so style application and layout have both settled. */
export function nextLayout(): Promise<void> {
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

/** What the WINDOW says its size is — never what the config asked for. */
export function observedViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROLS
//
// A harness wired to nothing reports a clean zero that is indistinguishable from
// a pass, so every claim this file makes about "the real stylesheet" has to be a
// non-zero COUNT or a resolved VALUE that could not exist without it.
// ─────────────────────────────────────────────────────────────────────────────

/** Every rule in the document, at-rules descended into. */
export function loadedCssRuleCount(): number {
  let n = 0;
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      n += 1;
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) walk(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    // A cross-origin sheet throws on `.cssRules`; none is expected here, and a
    // silent skip would understate the count, so let it throw rather than hide.
    walk(sheet.cssRules);
  }
  return n;
}

/**
 * Evidence, per source, that the cascade this harness claims to load is LOADED
 * AND APPLIED — each entry a value that is impossible without the stylesheet it
 * names, measured off a real element rather than read out of the CSSOM.
 *
 * Returned rather than asserted so a test states its own expectations; a helper
 * that both measures and judges is one nobody can watch fail.
 */
/**
 * The cascade-layer ORDER statement, and whether anything registered a layer
 * before it.
 *
 * 🔴 THE INVARIANT IS "NOTHING NAMED A LAYER FIRST", NOT "IT IS RULE ZERO".
 * A layer's priority is fixed at the first appearance of its NAME, so what has
 * to hold is that no `@layer <name> { … }` block is parsed before the `@layer a,
 * b, c;` statement. Asserting `document.styleSheets[0].cssRules[0]` instead
 * looked equivalent and is not: the runner injects sheets of its own, so that
 * check went red while the real invariant held — a control failing for a reason
 * that had nothing to do with what it claims to protect.
 */
export function layerOrderEvidence(): {
  /** The layer names in the `@layer a, b, c;` statement, or null if there is none. */
  declaredOrder: string[] | null;
  /** True when no `@layer <name> { … }` block precedes that statement. */
  declaredBeforeAnyLayerBlock: boolean;
} {
  let declaredOrder: string[] | null = null;
  let sawLayerBlockFirst = false;
  const haveStatement = typeof CSSLayerStatementRule !== 'undefined';
  const haveBlock = typeof CSSLayerBlockRule !== 'undefined';

  outer: for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (haveStatement && rule instanceof CSSLayerStatementRule) {
        declaredOrder = Array.from(rule.nameList);
        break outer;
      }
      if (haveBlock && rule instanceof CSSLayerBlockRule) {
        sawLayerBlockFirst = true;
        break outer;
      }
    }
  }
  return {
    declaredOrder,
    declaredBeforeAnyLayerBlock: declaredOrder !== null && !sawLayerBlockFirst,
  };
}

/**
 * Evidence that the cascade is loaded AND applied.
 *
 * 🔴 EVERY FIELD HERE HAS BEEN MEASURED IN BOTH TIERS AND KEPT ONLY IF IT
 * DISAGREES. A control that reports the same value with and without the thing it
 * is checking attributes nothing, and reads as a confirmation. The body's
 * `margin-top` was in this list and was CUT for exactly that reason: measured
 * 2026-09-03, it is `0px` in the `component` tier too — which loads 24 CSS rules
 * and no preflight at all — so it was evidence of nothing. What survived, with
 * both readings (`component` → `geometry`):
 *
 *   ruleCount                      24 → 3,677
 *   probeBoxSizing        content-box → border-box
 *   tailwindFlexUtility         block → flex
 */
export function cascadeEvidence(): {
  ruleCount: number;
  layerOrder: ReturnType<typeof layerOrderEvidence>;
  /** Preflight's `*, ::before, ::after { box-sizing: border-box }`; UA default is `content-box`. */
  probeBoxSizing: string;
  /** `@tailwind utilities` — inert in the `component` tier, which loads none of it. */
  tailwindFlexUtilityResolves: boolean;
  /** A `theme`-layer rule from globals.css. */
  htmlFontSize: string;
} {
  const probe = document.createElement('div');
  probe.className = 'flex';
  document.body.appendChild(probe);
  const probeStyle = getComputedStyle(probe);
  const evidence = {
    ruleCount: loadedCssRuleCount(),
    layerOrder: layerOrderEvidence(),
    probeBoxSizing: probeStyle.boxSizing,
    tailwindFlexUtilityResolves: probeStyle.display === 'flex',
    htmlFontSize: getComputedStyle(document.documentElement).fontSize,
  };
  probe.remove();
  return evidence;
}

// ─────────────────────────────────────────────────────────────────────────────
// MEASUREMENT
// ─────────────────────────────────────────────────────────────────────────────

/** A rounded border box. 2dp, so sub-pixel layout is visible but noise is not. */
export function box(el: Element): {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
} {
  const r = el.getBoundingClientRect();
  const q = (n: number) => Math.round(n * 100) / 100;
  return {
    top: q(r.top),
    right: q(r.right),
    bottom: q(r.bottom),
    left: q(r.left),
    width: q(r.width),
    height: q(r.height),
  };
}

/**
 * The union of an element's CHILD boxes — "how much box the content actually
 * needs", against which the parent's own box can be compared.
 *
 * 🔴 `scrollHeight` is NOT this and does not answer the same question: it is
 * clamped to the padding box, so a parent that is far TALLER than its content
 * reports its own height and the overshoot is invisible. That is precisely the
 * defect shape here — a 220px box around 53px of content — so the union is
 * computed from the children's own rects.
 *
 * Returns `null` for an element with no element children.
 */
export function childrenUnionBox(el: Element): ReturnType<typeof box> | null {
  const kids = Array.from(el.children);
  if (kids.length === 0) return null;
  const rects = kids.map((k) => k.getBoundingClientRect());
  const q = (n: number) => Math.round(n * 100) / 100;
  const top = Math.min(...rects.map((r) => r.top));
  const left = Math.min(...rects.map((r) => r.left));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const right = Math.max(...rects.map((r) => r.right));
  return {
    top: q(top),
    left: q(left),
    bottom: q(bottom),
    right: q(right),
    width: q(right - left),
    height: q(bottom - top),
  };
}

/**
 * A RESOLVED LONGHAND, by CSS property name.
 *
 * Read longhands, never the `flex` shorthand: `getComputedStyle(el).flex` is a
 * serialisation, so `flex: 1` and `flex: 1 1 0%` are the same string and a
 * `flex-basis` regression can hide inside it. `longhand(el, 'flex-basis')`
 * returns `220px` or `0%` and cannot.
 */
export function longhand(el: Element, property: string): string {
  return getComputedStyle(el).getPropertyValue(property).trim();
}

/** The three flex longhands together — the shape a `flex` shorthand bug lives in. */
export function flexLonghands(el: Element): { grow: string; shrink: string; basis: string } {
  return {
    grow: longhand(el, 'flex-grow'),
    shrink: longhand(el, 'flex-shrink'),
    basis: longhand(el, 'flex-basis'),
  };
}

/**
 * The axis a flex CONTAINER lays its children out on — the fact that decides
 * whether `flex-basis` is a width or a height, and the one nothing in the
 * attribute-level tier can see.
 */
export function flexAxis(el: Element): 'row' | 'column' | 'none' {
  const s = getComputedStyle(el);
  if (s.display !== 'flex' && s.display !== 'inline-flex') return 'none';
  return s.flexDirection.startsWith('column') ? 'column' : 'row';
}

/**
 * Render at an EXPLICIT viewport and hand back what the window actually reports.
 *
 * Throws rather than warns on a mismatch: a viewport call that silently did
 * nothing turns every geometry assertion in the file into a claim about a
 * different screen, and that is the failure mode this project exists to remove.
 * The throw is the harness's own floor — tests are still expected to assert
 * `observed` against their own literal.
 */
export async function renderAtViewport(
  ui: React.ReactElement,
  viewport: Viewport = PHONE_VIEWPORT
): Promise<{ result: ReturnType<typeof render>; observed: { width: number; height: number } }> {
  await page.viewport(viewport.width, viewport.height);
  const result = render(ui, { wrapper: Providers });
  await nextLayout();
  const observed = observedViewport();
  if (observed.width !== viewport.width || observed.height !== viewport.height) {
    throw new Error(
      `geometry harness: asked for a ${viewport.width}x${viewport.height} viewport but the window ` +
        `reports ${observed.width}x${observed.height}. Every measurement in this file would be ` +
        'about a screen nobody chose.'
    );
  }
  // 🔴 A SEPARATE FIELD, NOT A PROPERTY BOLTED ONTO THE RENDER RESULT.
  // `vitest-browser-react`'s return value does not accept an `Object.assign`ed
  // key (it reads back `undefined`), so a helper that decorated it would hand
  // every caller a silent `undefined` to assert against — a viewport check that
  // can only ever compare `undefined` to a literal, i.e. exactly the vacuous
  // shape this project exists to remove. Measured, not assumed.
  return { result, observed };
}

/** Render under the provider stack WITHOUT touching the viewport. */
export function renderWithProviders(ui: React.ReactElement) {
  return render(ui, { wrapper: Providers });
}

/** The 1x1 transparent PNG — same fixture, same reason, as `component-setup.tsx`. */
export const LOADABLE_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
