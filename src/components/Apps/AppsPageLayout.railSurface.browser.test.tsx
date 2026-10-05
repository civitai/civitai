/**
 * `/apps/*` LEFT RAIL — IS THE SURFACE ACTUALLY PAINTED?
 *
 * 🔴 WHAT THIS ADDS THAT `AppsPageLayout.chromeAlignment.browser.test.tsx` CANNOT.
 * That file's 12-route ledger proves the surface costs NO LAYOUT — it asserts the nav's
 * rect to the pixel across 12 routes x 3 viewports x 2 rail states, and the `margin: -8px`
 * / `padding: 8px` / `inset` box-shadow form exists precisely to satisfy it. But a class
 * that does nothing at all satisfies it equally well: DELETING every declaration from
 * `.railSurface` leaves that whole file green. So the two halves of the feature need two
 * different guards, and this is the one that says the panel is visible.
 *
 * 🔴 THE CLAIM IS A RELATIONSHIP, NOT A PROPERTY. "The rail has a background" is
 * satisfiable by a page where EVERYTHING has that background, which is exactly what a
 * mis-scoped selector produces — and it is also satisfiable, in the other direction, by a
 * harness in which the stylesheet never loaded and every element reports the same
 * `rgba(0, 0, 0, 0)`. What is asserted is therefore: the rail's surface is OPAQUE *and*
 * the body column beside it is TRANSPARENT. Neither of those two can be true while the
 * other is, unless the tint really landed on the rail and only on the rail. A test that
 * merely looked up `classes.railSurface` and found a string would pass with the
 * stylesheet deleted.
 *
 * 🔴 WHY THIS FILE LOADS `@mantine/core/styles.css`, AS THE CHROME-ALIGNMENT SIBLING DOES.
 * The fill and the ring are `var(--mantine-color-gray-0)` / `var(--mantine-color-dark-6)`
 * and `--mantine-color-gray-3` / `--mantine-color-dark-4`, which are declared by THAT
 * stylesheet. Without it every `var()` is unresolvable, the whole declaration is invalid
 * at computed-value time, and the background falls back to transparent — a red that would
 * read as "the feature is missing". Vitest browser mode runs each file in its own iframe,
 * so the import cannot leak into the sibling suites.
 *
 * 🔴 AND WHY IT MUST BE A CSS-MODULE COLOUR RATHER THAN A TAILWIND UTILITY. The shared
 * component harness loads Mantine's stylesheet and the CSS modules but NOT Tailwind (see
 * the docstring in `AppsPageLayout.chromeAlignment.browser.test.tsx` and the body-column
 * comment in `AppsPageLayout.tsx`, where a Tailwind-dependent width measured 34.7px here).
 * A `bg-gray-0 dark:bg-dark-6` utility pair — the ~100-call-site idiom elsewhere in the
 * repo — would therefore be UNOBSERVABLE in this harness: the assertions below would read
 * transparent and the guard would be a permanent red against correct code. The surface is
 * declared in the module stylesheet so that the thing production paints is the thing a
 * test can see.
 *
 * 🔴 THIS FILE IS A LOCAL INSTRUMENT, NOT AN ENFORCED GATE — RUN IT YOURSELF. It is a
 * `*.browser.test.tsx`, so `vitest.config.mts` collects it into the `component` project,
 * and no selector in `.github/workflows/lint.yml` names that project: the workflow runs
 * `--project 'unit*'`, `--project geometry` and the workspace `packages`/`apps` configs,
 * none of which can claim this glob. Its only CI home is the preview pipeline's
 * `preview / component-tests` status, which is report-only and non-blocking. So the
 * sentences above describing what this file "catches" are about what it catches FOR A
 * PERSON WHO RUNS IT — nothing here blocks a merge. Widening the component tier into a
 * blocking job is a real change with its own cost argument and belongs in its own PR — do
 * not bolt it on here. Run it with:
 *   pnpm exec vitest run --project component src/components/Apps/AppsPageLayout.railSurface.browser.test.tsx
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
// The rail's sticky top offset. Imported rather than restated so the bleed bound below is
// derived from the same constant the layout pins the rail with.
import { SUBNAV_STICKY_GAP } from '~/hooks/useSubnavBottom';

// The viewer must be one the rail renders for at all — `AppsPageLayout` drops the rail
// entirely below two qualifying sections. An author yields Marketplace + Build. Same
// mock set as the chrome-alignment sibling, for the same reason.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'author', isModerator: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } } },
}));

const { AppsPageLayout } = await import('./AppsPageLayout');
const { AppsRailProvider, APPS_RAIL_WIDTH, APPS_RAIL_COLLAPSED_WIDTH } = await import(
  './appsRailState'
);

/** `rgb(…)` / `rgba(…)` → its channels. A computed background is always one of those. */
function channelsOf(color: string): number[] {
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (!m) throw new Error(`not a computed rgb/rgba colour: "${color}"`);
  return m[1].split(/[,/]/).map((s) => Number(s.trim()));
}

function alphaOf(color: string): number {
  const parts = channelsOf(color);
  return parts.length >= 4 ? parts[3] : 1;
}

/** Relative luminance, so "which of these two fills is the LIGHT one" is a number. */
function luminanceOf(color: string): number {
  const [r, g, b] = channelsOf(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function renderRail(collapsed: boolean) {
  renderWithProviders(
    <AppsRailProvider value={collapsed ? 'collapsed' : 'open'}>
      <AppsPageLayout>
        <div data-testid="body" style={{ height: 200 }}>
          body
        </div>
      </AppsPageLayout>
    </AppsRailProvider>
  );
  await expect.element(page.getByTestId('body')).toBeInTheDocument();
  // Two frames so layout + the injected stylesheet have both settled, and so
  // MantineProvider's own colour-scheme effect has stamped the root element.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  const surface = document.querySelector('[data-apps-chrome="rail-surface"]') as HTMLElement | null;
  const bodyColumn = document.querySelector(
    '[data-apps-chrome="body-column"]'
  ) as HTMLElement | null;
  const container = document.querySelector('.mantine-Container-root') as HTMLElement | null;
  // 🔴 THE TWO ELEMENTS BETWEEN THE SURFACE AND THE BODY COLUMN, AND THE REASON THEY ARE
  // LOOKED UP AT ALL. `background-color` DOES NOT INHERIT, so a rule applied one level too
  // high leaves every descendant's computed value at `rgba(0, 0, 0, 0)` — the body column
  // and the Container cannot see a tint on the row or the aside SITTING BETWEEN THEM. An
  // earlier revision of this file claimed the body-column read caught a `.railRow` tint;
  // it could not. These are the levels that actually would.
  const row = document.querySelector('[data-apps-chrome="row"]') as HTMLElement | null;
  const aside = document.querySelector('[data-apps-chrome="rail"]') as HTMLElement | null;
  if (!surface || !bodyColumn || !container || !row || !aside) {
    throw new Error(
      `chrome not rendered (surface=${!!surface} body=${!!bodyColumn} container=${!!container} ` +
        `row=${!!row} aside=${!!aside}) — the mocked viewer must qualify for >=2 rail sections`
    );
  }
  return { surface, bodyColumn, container, row, aside };
}

beforeEach(async () => {
  // Every viewport here is >= APPS_RAIL_MIN_VIEWPORT (1300); below it the rail is
  // `display: none` and a display:none subtree still reports computed colours, so the
  // assertions would pass against a rail no user can see.
  await page.viewport(1440, 900);
});

describe('the rail surface is PAINTED, and only the rail is', () => {
  test('🔴 the rail panel is opaque WHILE nothing around it is', async () => {
    const { surface, bodyColumn, container, row, aside } = await renderRail(false);

    const surfaceBg = getComputedStyle(surface).backgroundColor;

    // THE POSITIVE HALF. A stylesheet that failed to load, a class that was renamed, or a
    // `.railSurface` emptied of declarations all land here as alpha 0.
    expect(alphaOf(surfaceBg), `rail surface background was "${surfaceBg}"`).toBeGreaterThan(0);

    // 🔴 THE CONTROL HALF — EVERY ANCESTOR BETWEEN THE SURFACE AND THE PAGE, NOT JUST THE
    // SIBLING COLUMN. `background-color` does not inherit, so a tint applied one level too
    // high leaves the body column reading `rgba(0, 0, 0, 0)` exactly as it does now: the
    // sibling read alone is satisfied by
    //     `.railRow { background: light-dark(gray-0, dark-6) }`
    // painting the ENTIRE page row while `.railSurface` is untouched. Naming each level
    // between the two is what makes "and only the rail is" a claim rather than a hope.
    for (const [label, el] of [
      ['body column', bodyColumn],
      ['row', row],
      ['aside', aside],
      ['container', container],
    ] as const) {
      const bg = getComputedStyle(el).backgroundColor;
      expect(alphaOf(bg), `${label} background was "${bg}" — the tint escaped the panel`).toBe(0);
    }

    // ⚠️ AN `expect(surfaceBg).not.toBe(bodyBg)` USED TO SIT HERE AND IS DELETED. Its
    // stated job — "the positive half cannot be satisfied by both being the same opaque
    // thing" — stopped being reachable the moment the loop above pinned the body column to
    // alpha 0: an opaque surface and a transparent body are unequal by construction, so no
    // mutation can fail that line while these pass. Kept, it would read as coverage and
    // provide none.
  });

  test('the hairline ring is an INSET shadow — no layout cost, and not a border', async () => {
    // Pinned because it is the half of the implementation a "tidy-up" is most likely to
    // rewrite: a `border: 1px` reads as the obvious way to draw this and takes the nav to
    // 259px, which is the failure the chrome-alignment ledger catches. Asserting the
    // mechanism here says WHY out loud, in the file that can see it.
    const { surface, row } = await renderRail(false);
    const style = getComputedStyle(surface);

    // 🔴 THE WIDTH IS PART OF THE CLAIM. A bare `toContain('inset')` is satisfied by
    // `box-shadow: inset 0 0 0 0 <colour>` — a spread of zero, which keeps the substring,
    // keeps every border at 0px, and keeps the two schemes different, while drawing no
    // hairline at all. The ring is what carries this panel in light mode, where the fill is
    // only one step off the page.
    // 🔴 THE 1px MUST BE IN THE SPREAD SLOT, NOT ANY SLOT. A bare `/\b1px\b/` is satisfied
    // by `box-shadow: inset 0 0 1px <colour>` — blur 1px, spread 0 — which computes to
    // `… 0px 0px 1px inset`, keeps every border at 0px, keeps the two schemes different,
    // and draws a faint blur instead of the crisp hairline the failure message names.
    // Pinning the full offset/blur/spread quadruple is what makes this a claim about the
    // ring rather than about the string.
    expect(
      style.boxShadow,
      `box-shadow was "${style.boxShadow}" — expected a crisp inset 1px SPREAD ring`
    ).toMatch(/0px 0px 0px 1px inset/);
    // A real border would consume layout; there must be none on any side.
    expect(style.borderTopWidth).toBe('0px');
    expect(style.borderRightWidth).toBe('0px');
    expect(style.borderBottomWidth).toBe('0px');
    expect(style.borderLeftWidth).toBe('0px');
    // The bleed and the give-back are equal and opposite on every side, which is what
    // makes the content box — and therefore the nav's measured rect — unchanged.
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const margin = parseFloat(style[`margin${side}` as 'marginTop']);
      const padding = parseFloat(style[`padding${side}` as 'paddingTop']);
      expect(margin, `margin${side}`).toBeLessThan(0);
      expect(margin + padding, `margin${side} + padding${side} must cancel`).toBe(0);
    }

    // 🔴 SYMMETRY AND MAGNITUDE, BECAUSE PER-SIDE CANCELLATION IS NOT ENOUGH.
    // `margin: -20px -8px -8px -8px` with the matching padding cancels on EVERY side, so
    // every assertion above passes, the nav's content box is untouched, and all 22 tests in
    // `AppsPageLayout.chromeAlignment.browser.test.tsx` stay green — while the panel now
    // bleeds 20px UPWARD into a 16px sticky offset and, once the rail is stuck, puts 4px of
    // clickable surface over the bottom of the global subnav. The rect test below only
    // measures the horizontal axis against the body column, so it cannot see it either.
    //
    // Both bounds are DERIVED from the things they must clear rather than restated, so
    // neither can go stale if the row gap or the sticky offset moves.
    const bleed = -parseFloat(style.marginTop);
    for (const side of ['Right', 'Bottom', 'Left'] as const) {
      expect(
        -parseFloat(style[`margin${side}` as 'marginTop']),
        `margin${side} must match marginTop — an asymmetric bleed escapes on one axis only`
      ).toBe(bleed);
    }
    const gap = parseFloat(getComputedStyle(row).columnGap);
    expect(bleed, `the bleed (${bleed}) must stay inside the row gap (${gap})`).toBeLessThan(gap);
    expect(
      bleed,
      `the bleed (${bleed}) must stay inside the sticky offset (${SUBNAV_STICKY_GAP}), or the ` +
        'stuck rail overlaps the global subnav and swallows clicks in it'
    ).toBeLessThan(SUBNAV_STICKY_GAP);

    expect(parseFloat(style.borderTopLeftRadius)).toBeGreaterThan(0);
  });

  /**
   * ⚠️ A `'the panel is painted in the COLLAPSED state too'` TEST WAS DELETED FROM HERE,
   * AND THE DELETION IS DELIBERATE. `.railSurface` applies its fill, ring and radius
   * UNCONDITIONALLY — nothing in the stylesheet or the layout branches on the collapse
   * state, and the collapse is expressed purely as an inline `width` on the `<aside>`. So
   * that test re-asserted the open-rail test's own two assertions against a rail whose
   * width differs, which no mutation of the paint can fail while the open-rail test passes.
   * Its stated justification — "a rule scoped to something only the open rail renders would
   * be invisible here" — describes a rule that does not exist and could not be written
   * against this stylesheet.
   *
   * The collapsed state IS still covered where it genuinely differs: the bled-rect test
   * below runs in both states, because the bleed is applied to the aside's width and that
   * width is exactly what the collapse changes. The ONE assertion worth keeping from the
   * deleted test — that the rail really is in the state its label claims — moved there
   * rather than being dropped with it.
   */
  test.each([
    { label: 'open', collapsed: false },
    { label: 'collapsed', collapsed: true },
  ])('🔴 the BLED RECT still clears the body column — rail $label', async ({ collapsed }) => {
    // 🔴 THE HAZARD NO OTHER GUARD CAN SEE, AND IT IS A HIT AREA, NOT A COLOUR.
    // `margin: -8px` grows this div's border box 8px past the `<aside>` on all four
    // sides — that is the whole mechanism, and it is why the paint reaches into the
    // gutter. It clears the body column ONLY because `.railRow`'s gap and the Container
    // gutter are both 16px, i.e. by exactly 8px with nothing to spare.
    //
    // `AppsPageLayout.chromeAlignment.browser.test.tsx` measures
    // `nav[aria-label="App sections"]`, never this div, so its 22-test ledger is
    // structurally blind to the surface's own rect: narrow the gap, or widen the bleed,
    // and this element starts overlapping the body column and SWALLOWING CLICKS in it
    // with every existing assertion still green. The paint assertions above cannot see
    // it either — an overlapping panel is still opaque, and the body column it covers is
    // still transparent.
    //
    // Asserted in both rail states because the aside's width differs between them and
    // the bleed is applied to whatever that width is.
    const { surface, bodyColumn, aside } = await renderRail(collapsed);

    // 🔴 FIRST, PROVE THE RAIL IS ACTUALLY IN THE STATE THIS ROW NAMES. Without it, if
    // `AppsRailProvider`'s value ever stops driving `collapsed`, the collapsed row silently
    // measures the OPEN rail — it still passes, and the only thing that was wrong is the
    // sentence in the test title. Both rows then assert the same thing twice.
    expect(
      aside.offsetWidth,
      `the rail is not in its ${collapsed ? 'collapsed' : 'open'} state — this row is ` +
        'measuring the other one'
    ).toBe(collapsed ? APPS_RAIL_COLLAPSED_WIDTH : APPS_RAIL_WIDTH);

    const surfaceRect = surface.getBoundingClientRect();
    const bodyRect = bodyColumn.getBoundingClientRect();

    expect(
      Math.round(bodyRect.left - surfaceRect.right),
      `the rail panel (right ${surfaceRect.right}) reaches the body column ` +
        `(left ${bodyRect.left}) — it would swallow clicks meant for the page`
    ).toBeGreaterThan(0);
  });

  test('🔴 `light-dark()` really resolved — the two schemes give DIFFERENT fills', async () => {
    // The mutation this closes: `background: var(--mantine-color-gray-0)` alone (no
    // `light-dark()`) is opaque in both schemes and passes every assertion above, while
    // painting a near-white panel onto a dark page. `postcss-preset-mantine` compiles
    // `light-dark(a, b)` into a pair of `[data-mantine-color-scheme]`-scoped rules, so the
    // discriminating observation is that flipping that attribute MOVES the colour.
    const { surface } = await renderRail(false);
    const root = document.documentElement;
    const previous = root.getAttribute('data-mantine-color-scheme');

    let light = '';
    let lightRing = '';
    let dark = '';
    let darkRing = '';
    try {
      root.setAttribute('data-mantine-color-scheme', 'light');
      light = getComputedStyle(surface).backgroundColor;
      lightRing = getComputedStyle(surface).boxShadow;

      root.setAttribute('data-mantine-color-scheme', 'dark');
      dark = getComputedStyle(surface).backgroundColor;
      darkRing = getComputedStyle(surface).boxShadow;
    } finally {
      // `finally`, so a throw between the flip and here cannot leave the document
      // re-themed for whatever test is appended after this one.
      if (previous === null) root.removeAttribute('data-mantine-color-scheme');
      else root.setAttribute('data-mantine-color-scheme', previous);
    }

    expect(alphaOf(light), `light fill was "${light}"`).toBeGreaterThan(0);
    expect(alphaOf(dark), `dark fill was "${dark}"`).toBeGreaterThan(0);
    expect(dark, `both schemes painted "${light}" — light-dark() did not resolve`).not.toBe(light);
    // The ring is a light-dark() pair too, and is the half more easily left as a single
    // constant since a 1px line looks plausible in either scheme.
    expect(darkRing, `both schemes ringed "${lightRing}"`).not.toBe(lightRing);

    // 🔴 POLARITY, NOT JUST DIFFERENCE. "The two schemes differ" is satisfied by the
    // arguments being SWAPPED — `light-dark(dark-6, gray-0)` gives a charcoal panel on the
    // light theme and a near-white one on the dark theme, and every assertion above stays
    // green. It also kills the weaker `light-dark(gray-0, gray-1)` mutant, two near-whites
    // that differ by a hair. Luminance is the one property a reviewer would eyeball, so it
    // is the one asserted.
    expect(
      luminanceOf(light),
      `light "${light}" is not lighter than dark "${dark}" — the light-dark() arms are swapped`
    ).toBeGreaterThan(luminanceOf(dark));
    // A real separation, not a rounding difference: the two fills are unmistakably
    // different tones rather than neighbouring shades of one.
    expect(luminanceOf(light) - luminanceOf(dark)).toBeGreaterThan(100);
  });
});
