import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AppsRailState } from '~/components/Apps/appsRailGeometry';
import {
  APPS_RAIL_COOKIE,
  APPS_RAIL_COOKIE_MAX_AGE,
  APPS_RAIL_DEFAULT_STATE,
  APPS_RAIL_STORAGE_KEY,
  parseAppsRailState,
} from '~/components/Apps/appsRailGeometry';

/**
 * `/apps/*` LEFT RAIL — the SSR cookie seed and the client store.
 *
 * 🔴 WHY THERE IS A COOKIE AT ALL, AND WHY `localStorage` ALONE IS NOT ENOUGH.
 * Every `/apps/*` page is server-rendered through `createServerSideProps`, and
 * `localStorage` does not exist on a server. Seeding the rail from `localStorage` alone
 * therefore means the server ALWAYS renders it open: a viewer who collapsed it gets an
 * open rail in the HTML, then a 260 → 56 jump on hydration. That is not only a flash —
 * the store grid underneath is a container query, so 204px of returned width
 * RE-LADDERS the whole grid and every card resizes. The cookie is what lets the SERVER
 * render the state the viewer chose.
 *
 * So the two stores have different jobs and neither is redundant:
 *   • the COOKIE is the SSR seed. It is parsed in `_app`'s `getInitialProps` alongside
 *     `consent` / `disableHidden` / `referrals` (see `~/shared/utils/cookies`) and handed
 *     to {@link AppsRailProvider} exactly the way those three are handed to their own
 *     providers. That is the established pattern in this repo for an SSR-seeded client
 *     value, and it is what makes the first paint correct.
 *   • `localStorage` is the client-side store the rail persists to, and it is the
 *     FALLBACK when no cookie reaches the server (cookie cleared, a surface rendered
 *     outside `_app`, a test). It is read in an EFFECT, never during render — see
 *     {@link useAppsRail} for why that ordering is the hydration-safe one.
 *
 * The pure geometry (widths, gap, the 1300px threshold, the cookie parser) lives in
 * `appsRailGeometry.ts` and is re-exported below, so a consumer imports one name from
 * one place regardless of which half owns it.
 */
export * from '~/components/Apps/appsRailGeometry';

/**
 * The SSR SEED.
 *
 * `null` means "no seed reached this tree" — which is different from "the seed said
 * open", and the difference decides whether {@link useAppsRail} is allowed to adopt a
 * `localStorage` value after mount. With a seed present the cookie is authoritative and
 * adopting anything else would be the very reflow the cookie exists to prevent.
 */
const AppsRailSeedContext = createContext<AppsRailState | null>(null);

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
   * The rail cookie as the server parsed it — or `undefined` when the request carried
   * NO rail cookie.
   *
   * 🔴 `undefined` IS LOAD-BEARING AND MUST NOT BE DEFAULTED AWAY BY THE CALLER. It is the
   * only signal that lets {@link useAppsRail} fall back to `localStorage`; collapse it to
   * `'open'` and that whole half of the feature becomes write-only. See the note on
   * `appsRail` in `~/shared/utils/cookies` for how that shipped once and what caught it.
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
  // `?? null` — the context's own "no seed" value. `undefined` would be indistinguishable
  // from an absent Provider once it reaches `useContext`, which is the same collapse one
  // level down.
  return (
    <AppsRailSeedContext.Provider value={value ?? null}>
      <AppsRailStoreContext.Provider value={store}>{children}</AppsRailStoreContext.Provider>
    </AppsRailSeedContext.Provider>
  );
}

/** Write the state to BOTH stores. No-ops outside a browser. */
export function persistAppsRailState(next: AppsRailState) {
  if (typeof document === 'undefined') return;
  try {
    window.localStorage.setItem(APPS_RAIL_STORAGE_KEY, next);
  } catch {
    // Private mode / storage disabled. The cookie below still carries the state.
  }
  // `SameSite=Lax` and no `Secure`: this is a layout preference, never a credential, and
  // it has to survive plain-http local development.
  document.cookie = `${APPS_RAIL_COOKIE}=${next}; path=/; max-age=${APPS_RAIL_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/** Read the client-side store. `null` when absent or unreadable. */
export function readAppsRailStorage(): AppsRailState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(APPS_RAIL_STORAGE_KEY);
    return raw === null ? null : parseAppsRailState(raw);
  } catch {
    return null;
  }
}

/**
 * The rail's collapse state and its toggle.
 *
 * 🔴 THE INITIAL VALUE COMES FROM THE COOKIE SEED, NOT FROM `localStorage`, AND THE
 * ORDERING IS THE POINT. Reading `localStorage` during render would make the first
 * client render differ from the server's whenever the two disagree, which is a
 * hydration mismatch; reading it in an EFFECT cannot, because effects run after
 * hydration has already matched. So the cookie decides the first paint and
 * `localStorage` is consulted only when NO seed arrived at all — the case where the
 * server could not have known, so there is nothing to mismatch with.
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
  const [local, setLocal] = useState<AppsRailState>(seed ?? APPS_RAIL_DEFAULT_STATE);

  const state = shared ? shared.state : local;
  const setState = shared ? shared.setState : setLocal;

  const adopted = useRef(false);
  useEffect(() => {
    // Only when the server could not have known. With a seed present the cookie is
    // authoritative and adopting a different value here would re-introduce the reflow
    // the cookie exists to prevent.
    if (adopted.current || seed !== null) return;
    adopted.current = true;
    const stored = readAppsRailStorage();
    if (!stored) return;
    setState(stored);
    // 🔴 RE-SEED THE COOKIE, OR THIS REFLOW HAPPENS ON EVERY HARD LOAD, FOREVER.
    // Adopting from storage without writing the cookie back leaves the server in exactly
    // the state that made the adoption necessary: the next full page load of ANY
    // `/apps/*` route SSRs the rail OPEN (260px), hydration matches, and this effect
    // snaps it to 56px again — taking the container-queried store grid with it. That is
    // the "260 → 56 jump on hydration … re-ladders the whole grid and every card resizes"
    // this module's own header says the cookie exists to prevent, reintroduced by the fix
    // that made the fallback reachable. Client-side navigation is unaffected (the
    // Provider is above the router outlet); direct entry, refresh and any external link
    // into `/apps/*` are not.
    //
    // With the write, the cohort pays the flash ONCE and the cookie carries them
    // thereafter — which is what `~/shared/utils/cookies` already promises in prose
    // ("after ONE post-mount adoption"). Caught by a delta audit of the very commit that
    // made this branch live.
    persistAppsRailState(stored);
  }, [seed, setState]);

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
