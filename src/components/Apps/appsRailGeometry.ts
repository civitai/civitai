import { APPS_RAIL_COOKIE } from '~/shared/utils/cookies';

/**
 * `/apps/*` LEFT RAIL — the pure geometry + persistence VOCABULARY.
 *
 * 🔴 DEPENDENCY-FREE ON PURPOSE. `appListingGrid.ts` derives the store's four-column
 * threshold from {@link appsRailChromeWidth}, and that module is read by node-tier unit
 * tests and by `AppListingsMarketplaceBody.module.scss`'s seam test. Splitting the
 * constants out of `appsRailState.tsx` keeps React (and, through
 * `~/hooks/useSubnavBottom`, the scroll-area context) off that path entirely. The React
 * half re-exports everything here, so a consumer never has to know which file a name
 * lives in.
 */

/** The open rail's width, px. */
export const APPS_RAIL_WIDTH = 260;

/** The collapsed, icon-only rail's width, px. */
export const APPS_RAIL_COLLAPSED_WIDTH = 56;

/**
 * The gap between the rail and the page body, px.
 *
 * 🔴 IT IS THE SAME 16 AS `SUBNAV_STICKY_GAP`, AND THAT EQUALITY IS ASSERTED RATHER
 * THAN IMPORTED. The rail is pinned to `subnavBottom + SUBNAV_STICKY_GAP`, so its top
 * gap and its side gap must be one number or the rail sits in an asymmetric corner.
 * Importing `~/hooks/useSubnavBottom` here would drag React into this module and undo
 * the whole reason it is separate, so `__tests__/appsRailGeometry.test.ts` pins the two
 * together instead. Move one and that test goes red.
 */
export const APPS_RAIL_GAP = 16;

/**
 * The narrowest VIEWPORT at which the rail renders at all. Below this the sections move
 * into a `Drawer` opened from the page header band (the `CollectionsLayout` mobile
 * pattern).
 *
 * 🔴 IT IS EXPRESSED IN CSS, NOT IN A MEDIA-QUERY HOOK, AND THAT IS A HYDRATION
 * DECISION RATHER THAN A STYLE PREFERENCE. `window.matchMedia` has no server-side
 * answer, so a hook-driven swap renders the drawer shape on the server and the rail
 * shape on a desktop's first client paint — a mismatch of exactly the kind that once
 * bailed hydration of the entire `/apps` root and left every page inert. Both shapes are
 * rendered unconditionally and the browser picks one with a `@media` rule in
 * `AppsPageLayout.module.scss`, so the server HTML and the first client render are
 * byte-identical and there is no flash on either side.
 *
 * 🔴 THE NUMBER IS PINNED AGAINST THE STYLESHEET in
 * `__tests__/appsRailGeometry.test.ts` — the same seam guard `appListingGrid.test.ts`
 * puts on the store grid's container queries, and for the same reason: a TypeScript
 * constant nothing at runtime reads is exactly the thing that silently stops describing
 * the CSS.
 *
 * WHERE 1300 CAME FROM, and the caveat. It was chosen so a COLLAPSED rail still leaves
 * room for the store's four-column rung AS IT WAS BEFORE THIS CHANGE: at viewport 1280
 * with a 10px reserved scrollbar the grid is `1280 − 10 − 32 − 72 = 1166` against a
 * four-column rung of 1168 — two pixels short — while 1300 gives 1186 and clears it.
 * ⚠️ THAT DERIVATION IS NO LONGER LOAD-BEARING AND IS KEPT ONLY AS PROVENANCE. The
 * ladder re-tune shipped alongside the rail moves the four-column rung to 2242 of grid,
 * which no viewport near 1300 reaches with or without a rail — so the ladder no longer
 * discriminates between 1280 and 1300 at all, and 1300 now stands purely on "is there
 * room for 276px of chrome plus a usable body". Do not re-derive the old arithmetic as
 * if it still decided this number.
 */
export const APPS_RAIL_MIN_VIEWPORT = 1300;

/**
 * The width a scroll container reserves for a THIN scrollbar on the platforms that
 * reserve one at all (Windows / Linux Chrome + Firefox), px.
 *
 * 🔴 NOT A STYLE CONSTANT — a DERIVATION INPUT, and the reason the store ladder's
 * four-column rung is 2242 rather than 2252. `/apps` renders inside `.scroll-area`,
 * which `src/styles/globals.css` gives `scrollbar-width: thin` while
 * `html, body { overflow: hidden }` removes the document scroll — so the apps
 * `Container` sits inside a scrollbar-consuming box and the grid is
 * `viewport − scrollbar − APPS_CONTAINER_GUTTER − rail`. macOS overlay scrollbars and
 * touch reserve nothing, which is the LOOSER case: it yields 10px MORE grid, so a rung
 * placed for the reserving platform fires on both. Placing it for the non-reserving one
 * would have left Windows 10px short of its own desktop width.
 */
export const APPS_RESERVED_SCROLLBAR = 10;

/**
 * The horizontal chrome the rail costs the page body: the rail itself plus its gap.
 *
 * ONE function, several callers (the layout, the store ladder, every geometry test), so
 * "276 open / 72 collapsed" is arithmetic rather than literals that can drift.
 */
export function appsRailChromeWidth(collapsed: boolean): number {
  return (collapsed ? APPS_RAIL_COLLAPSED_WIDTH : APPS_RAIL_WIDTH) + APPS_RAIL_GAP;
}

/** The persisted rail state. A closed set, so an unknown value can only mean "open". */
export type AppsRailState = 'open' | 'collapsed';

/**
 * 🔴 OPEN BY DEFAULT, AND THE DEFAULT IS ALSO THE PARSE FAILURE MODE. Anything that is
 * not the exact literal `'collapsed'` resolves to `'open'`, so a truncated cookie, a
 * stale value from an older spelling, or a `localStorage` entry written by a different
 * feature can only ever fail OPEN — a visible navigation — rather than hiding the nav.
 */
export const APPS_RAIL_DEFAULT_STATE: AppsRailState = 'open';

/**
 * The cookie the SERVER reads to render the right first paint. Re-exported from
 * `~/shared/utils/cookies`, which owns the literal — see the note there for why the name
 * lives at the bottom of the dependency graph rather than here.
 */
export { APPS_RAIL_COOKIE };

/** The `localStorage` key — the client-side store. Same name on purpose. */
export const APPS_RAIL_STORAGE_KEY = APPS_RAIL_COOKIE;

/** A year, in seconds — the rail's cookie lifetime. */
export const APPS_RAIL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Narrow an arbitrary stored value to {@link AppsRailState}. Never throws. */
export function parseAppsRailState(value: string | undefined | null): AppsRailState {
  return value === 'collapsed' ? 'collapsed' : APPS_RAIL_DEFAULT_STATE;
}

/**
 * Read the rail cookie out of a raw `Cookie:` header.
 *
 * `~/shared/utils/cookies` goes through `cookies-next`, which needs a request context;
 * this takes the header string so the SSR seed can be unit-tested with no Next.js
 * machinery at all.
 */
export function readAppsRailCookie(cookieHeader: string | undefined): AppsRailState {
  if (!cookieHeader) return APPS_RAIL_DEFAULT_STATE;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== APPS_RAIL_COOKIE) continue;
    return parseAppsRailState(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return APPS_RAIL_DEFAULT_STATE;
}
