import React, { createContext, useCallback, useContext, useState } from 'react';
import type { AppsRailState } from '~/components/Apps/appsRailGeometry';
import {
  APPS_RAIL_COOKIE,
  APPS_RAIL_COOKIE_MAX_AGE,
  APPS_RAIL_DEFAULT_STATE,
} from '~/components/Apps/appsRailGeometry';

/**
 * `/apps/*` LEFT RAIL — the SSR cookie seed and the client store.
 *
 * 🔴 THE COOKIE IS THE ONLY STORE, AND IT HAS TO BE. Every `/apps/*` page is
 * server-rendered through `createServerSideProps`, and a cookie is the only client value
 * that reaches the server. Seeding the rail from anything else means the server ALWAYS
 * renders it open: a viewer who collapsed it gets an open rail in the HTML, then a
 * 260 → 56 jump on hydration. That is not only a flash — the store grid underneath is a
 * container query, so 204px of returned width RE-LADDERS the whole grid and every card
 * resizes. The cookie is what lets the SERVER render the state the viewer chose. It is
 * parsed in `_app`'s `getInitialProps` alongside `consent` / `disableHidden` /
 * `referrals` (see `~/shared/utils/cookies`) and handed to {@link AppsRailProvider}
 * exactly the way those three are handed to their own providers.
 *
 * ⚠️ THERE WAS A SECOND STORE AND IT IS DELETED. `localStorage` was written alongside the
 * cookie and adopted in a post-mount effect when no cookie reached the server. It served
 * exactly one cohort — cookie cleared, storage survived — who now simply re-collapse the
 * rail once and are carried by the cookie thereafter. It cost two audit rounds and caught
 * nothing: round 0 found the fallback was DEAD CODE in production (the zod schema could
 * never return `undefined`, so the discriminator that gated it never fired), and round 2
 * found that the fix making it reachable reintroduced a reflow on EVERY hard load,
 * because adopting from storage without re-seeding the cookie leaves the server in the
 * state that made the adoption necessary. One store cannot disagree with itself.
 *
 * The pure geometry (widths, gap, the 1300px threshold, the cookie parser) lives in
 * `appsRailGeometry.ts` and is re-exported below, so a consumer imports one name from
 * one place regardless of which half owns it.
 */
export * from '~/components/Apps/appsRailGeometry';

/**
 * The SSR SEED — the cookie value the server rendered with.
 *
 * Its default IS {@link APPS_RAIL_DEFAULT_STATE} rather than a "no seed" sentinel. The
 * old `null` sentinel existed only to tell {@link useAppsRail} whether it was allowed to
 * adopt a `localStorage` value after mount; with that store deleted there is nothing to
 * decide, and an absent cookie and a cookie saying "open" mean the same thing.
 */
const AppsRailSeedContext = createContext<AppsRailState>(APPS_RAIL_DEFAULT_STATE);

type AppsRailStore = {
  state: AppsRailState;
  setState: (next: AppsRailState) => void;
};

const AppsRailStoreContext = createContext<AppsRailStore | null>(null);

/**
 * Seeds the rail from the cookie `_app` already parses.
 *
 * 🔴 MOUNTED IN `_app`, ABOVE THE ROUTER OUTLET, AND THAT PLACEMENT IS THE WHOLE REASON
 * THE COLLAPSE STATE IS ONE GLOBAL VALUE RATHER THAN TWELVE PER-ROUTE ONES. Next's
 * pages router swaps the page component on every navigation, so anything held in
 * `AppsPageLayout`'s own `useState` is destroyed and re-seeded on each route change —
 * i.e. collapsing the rail on `/apps` and clicking through to `/apps/build` would
 * re-open it. `AppsPageLayout.chromeAlignment.browser.test.tsx` asserts the rail's left
 * edge and width are identical on all 12 routes, and that invariant is the entire reason
 * `AppsPageLayout` exists; a per-route value breaks it by design.
 */
export function AppsRailProvider({
  value,
  children,
}: {
  /**
   * The rail cookie as the server parsed it — or `undefined` when the request carried NO
   * rail cookie, which defaults to {@link APPS_RAIL_DEFAULT_STATE}.
   *
   * ⚠️ `undefined` USED TO BE LOAD-BEARING AND NO LONGER IS. It was the discriminator
   * that told `useAppsRail` whether to consult `localStorage`; with that store deleted
   * there is nothing to discriminate for, and an absent cookie simply means "open". The
   * zod schema in `~/shared/utils/cookies` still yields `undefined` for an absent cookie
   * — that is deliberate and untouched, it just no longer carries a second meaning here.
   */
  value: AppsRailState | undefined;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<AppsRailState>(value ?? APPS_RAIL_DEFAULT_STATE);
  // 🔴 A FRESH OBJECT PER STATE CHANGE, NOT A `useRef` MUTATED IN PLACE. A stable
  // container whose fields are reassigned keeps the CONTEXT VALUE'S IDENTITY constant,
  // so React skips every consumer and the toggle renders nothing — the classic
  // silent-no-op shape for a context store.
  const store = React.useMemo<AppsRailStore>(() => ({ state, setState }), [state]);
  return (
    <AppsRailSeedContext.Provider value={value ?? APPS_RAIL_DEFAULT_STATE}>
      <AppsRailStoreContext.Provider value={store}>{children}</AppsRailStoreContext.Provider>
    </AppsRailSeedContext.Provider>
  );
}

/**
 * Write the state to the cookie. No-ops outside a browser.
 *
 * 🔴 THE COOKIE IS THE ONLY STORE. There was a parallel `localStorage` write here; it is
 * deleted. The cookie is the mechanism — it is the only one that reaches the SERVER, so
 * it is what decides the SSR seed and therefore the first paint. `localStorage` could
 * only ever serve one cohort (cookie cleared, storage survived), who now re-collapse the
 * rail once and are carried by the cookie thereafter. That cohort cost two audit rounds
 * — round 0 found the fallback was DEAD CODE in production, and round 2 found the fix
 * for it reintroduced a reflow on every hard load — and caught nothing in exchange.
 */
export function persistAppsRailState(next: AppsRailState) {
  if (typeof document === 'undefined') return;
  // `SameSite=Lax` and no `Secure`: this is a layout preference, never a credential, and
  // it has to survive plain-http local development.
  document.cookie = `${APPS_RAIL_COOKIE}=${next}; path=/; max-age=${APPS_RAIL_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * The rail's collapse state and its toggle.
 *
 * 🔴 THE COOKIE IS THE ONLY STORE, SO THE FIRST PAINT CANNOT DISAGREE WITH THE SERVER.
 * The initial value is the SSR seed and nothing else is read during render — there is no
 * post-mount adoption, so the class of hydration mismatch this module's header warns
 * about is now structurally absent rather than merely avoided by careful ordering.
 */
export function useAppsRail(): {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggle: () => void;
} {
  const seed = useContext(AppsRailSeedContext);
  const shared = useContext(AppsRailStoreContext);
  // The provider-less fallback (component tests, any surface rendered outside `_app`).
  // Per-mount rather than global, which is why the "one global value" guard drives the
  // PROVIDER — see the note on `AppsRailProvider`.
  const [local, setLocal] = useState<AppsRailState>(seed);

  const state = shared ? shared.state : local;
  const setState = shared ? shared.setState : setLocal;

  const setCollapsed = useCallback(
    (next: boolean) => {
      const value: AppsRailState = next ? 'collapsed' : 'open';
      setState(value);
      persistAppsRailState(value);
    },
    [setState]
  );

  return {
    collapsed: state === 'collapsed',
    setCollapsed,
    toggle: () => setCollapsed(state !== 'collapsed'),
  };
}
