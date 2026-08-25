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
 * 🔴 Do NOT rewrite `PageBlockHost`'s viewport-fit calc to
 * `calc(… - var(--header-height))`. Measured, in the component-test Chromium:
 * `globals.css` is NOT loaded there, so `--header-height` reads as `""`, the
 * declaration is invalid at computed-value time, and the host stops claiming a
 * viewport-derived height — as a column flex item its `min-height` computes to
 * `auto` and it clamps to its parent instead. The browser suite's RED ARM (which
 * asserts the legacy styling really does overflow) then FAILS:
 * `expected 716 to be greater than 716`.
 *
 * So the failure is LOUD, not silent — an earlier version of this comment claimed
 * the opposite and was wrong. The reason to interpolate the constant is fidelity,
 * not rescue: it makes the component render identically under test and in
 * production, instead of behaving one way in a browser that has `globals.css` and
 * another in one that does not. Note the net is only as strong as its tier —
 * `preview / component-tests` is REPORT-ONLY and does not block a merge.
 *
 * This prohibition is about THIS calc, which a browser test measures without
 * `globals.css`. It is NOT a blanket rule: many components legitimately use
 * `var(--header-height)` in styles no test asserts on. Defining the custom
 * property in `test/component-setup.tsx` would remove the asymmetry for all of
 * them and make this note unnecessary.
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
