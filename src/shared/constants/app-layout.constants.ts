/**
 * The site header's height, in px. THE single source for TypeScript consumers —
 * `AppHeader` sets the header to it, and anything computing "viewport minus the
 * header" subtracts it.
 *
 * 🔴 There is a second, unavoidable declaration: `--header-height` in
 * `src/styles/globals.css`, which is what the CSS call sites across the repo use
 * (the large majority of consumers). CSS cannot import a TS constant, so the two
 * are bound by an ASSERTED guard instead of by hope — `pageRunScrollContract.test.ts`
 * walks `src/`, requires exactly ONE declaration of each, and fails if they
 * disagree. Change one and that test tells you about the other.
 *
 * ⚠️ **RETIRED PROHIBITION — kept as history, not as a rule.** This comment used to
 * forbid rewriting `PageBlockHost`'s viewport-fit calc to
 * `calc(… - var(--header-height))`, because the component-test harness loaded no
 * global stylesheet: the custom property read as `""`, the declaration was invalid
 * at computed-value time, and the component laid out differently under test than
 * in production. **That is fixed** — `test/component-setup.tsx` now injects the
 * `:root` custom properties parsed out of `globals.css`, and
 * `src/components/AppLayout/rootCustomProperties.browser.test.tsx` is the guard
 * that proves they resolve. Measured there, with and without the injection:
 * `--header-height` `""` → `60px`, and `calc(100dvh - var(--header-height))`
 * `0px` → `viewport − 60`.
 *
 * So `var(--header-height)` is now safe in a component that a browser test
 * measures. The calc in `PageBlockHost` still interpolates this constant, and that
 * is a deliberate non-change rather than a leftover: switching it would leave
 * `AppHeader` as this constant's only consumer and would need the CSS/TS binding
 * guard re-pointed, which is a refactor with its own risk and no user-visible
 * benefit. Do it as its own change if you want it, not incidentally.
 */
export const HEADER_HEIGHT_PX = 60;

export const imageGenerationDrawerZIndex = 301;

/** Joyride's overlay. Anything a tour step expects the user to click must clear it. */
export const tourOverlayZIndex = 100000;

/**
 * The remix menu opens from cards that sit inside routed dialogs, which stack at
 * `300 + index` (DialogProvider), so Mantine's popover default of 300 only wins
 * on mount order. This clears a few levels of dialog stacking outright.
 */
export const remixMenuZIndex = 310;
