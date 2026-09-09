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
 * `0px` → `viewport − 60`. ⚠️ That guard lives in `preview / component-tests`,
 * which is REPORT-ONLY and does not block a merge — so it tells you, it does not
 * stop you. The CSS↔TS value binding it leans on is in the gating tier
 * (`pageRunScrollContract.test.ts`).
 *
 * So `var(--header-height)` is now safe in a component that a browser test
 * measures. The calc in `PageBlockHost` still interpolates this constant, and that
 * is a deliberate non-change rather than a leftover: switching it would leave
 * `AppHeader` as this constant's only consumer and would need the CSS/TS binding
 * guard re-pointed, which is a refactor with its own risk and no user-visible
 * benefit. Do it as its own change if you want it, not incidentally.
 */
export const HEADER_HEIGHT_PX = 60;

/**
 * The `<meta name="viewport">` content string, rendered by `MetaPWA` — the ONLY
 * viewport meta in the app.
 *
 * 🔴 `viewport-fit=cover` is what makes `env(safe-area-inset-*)` resolve to a
 * NON-ZERO value on a notched device. Without it the UA reports `0px` for every
 * inset, so every `env(safe-area-inset-*)` in the codebase silently no-ops —
 * which is exactly the state this repo was in until this token was added, with
 * one call site (`ReviewActionBar`) written against insets that could never
 * arrive.
 *
 * The flip side, and the reason this is a whole-string constant rather than a
 * token someone appends to: with `cover` the layout viewport extends UNDER the
 * status bar / notch / home indicator. `html`/`body`/`#__next` are a
 * `block-size: 100%; overflow: hidden` app shell (`src/styles/globals.css`), so
 * that shell now spans the full physical screen and anything pinned to a
 * viewport edge sits under system UI unless it pays the inset back with
 * `var(--safe-area-inset-*)`. Removing the token would re-zero every inset and
 * make that padding inert without any test that only greps for the padding
 * noticing; `viewport-fit-cover.test.ts` pins this string as a whole.
 */
export const VIEWPORT_META_CONTENT = 'initial-scale=1, width=device-width, viewport-fit=cover';

export const imageGenerationDrawerZIndex = 301;

/** Joyride's overlay. Anything a tour step expects the user to click must clear it. */
export const tourOverlayZIndex = 100000;

/**
 * How far above its overlay `react-joyride` draws the step tooltip — its
 * `getStyles` hardcodes `options.zIndex + 100` and reports it nowhere, so
 * `tour-click-through-z-index.test.ts` pins this against the installed package.
 */
export const tourTooltipZIndexOffset = 100;

/**
 * For anything a tour step expects the user to click that is not the target
 * itself — the menu a spotlit button opens.
 *
 * Clearing `tourOverlayZIndex` is not enough. The overlay swallows clicks, but
 * the tooltip is drawn above it, so a menu at overlay+1 opens *under* the
 * tooltip; a step with `hideFooter` then has no reachable way forward.
 */
export const tourClickThroughZIndex = tourOverlayZIndex + tourTooltipZIndexOffset + 1;

/**
 * The remix menu opens from cards that sit inside routed dialogs, which stack at
 * `300 + index` (DialogProvider), so Mantine's popover default of 300 only wins
 * on mount order. This clears a few levels of dialog stacking outright.
 */
export const remixMenuZIndex = 310;
