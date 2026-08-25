/**
 * The site header's height, in px. THE single source for TypeScript consumers —
 * `AppHeader` sets the header to it, and anything computing "viewport minus the
 * header" subtracts it.
 *
 * 🔴 There is a second, unavoidable declaration: `--header-height` in
 * `src/styles/globals.css`, which is what the CSS call sites across the repo use
 * (the large majority of consumers). CSS cannot import a TS constant, so the two
 * are bound by an ASSERTED
 * guard instead of by hope — `pageRunScrollContract.test.ts` parses the custom
 * property out of `globals.css` and fails if it disagrees with this value. Change
 * one and that test tells you about the other.
 *
 * 🔴 Do NOT "simplify" a TS consumer to `calc(… - var(--header-height))`.
 * Measured in Chromium: when the custom property is not defined in that document,
 * the whole declaration is invalid at computed-value time and `min-height`
 * collapses to `0px` — silently. `globals.css` is not loaded in the component-test
 * environment, so the browser suite's RED ARM (which asserts the legacy
 * viewport-fit styling really does overflow) would stop reproducing and go green
 * for the wrong reason. Interpolating this constant keeps the value identical in
 * both environments.
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
