import { installBrowserErrorLog } from '~/utils/feedback/browserErrorLog';

/**
 * Side-effect module: starts the bounded console/network snapshot that a feedback submission
 * attaches. Imported for its side effect from `_app.tsx`, alongside `~/utils/disable-router-prefetch`
 * and for the same reason — it has to be running before the thing it watches for can happen.
 *
 * 🔴 IT INSTALLS AT MODULE EVALUATION, NOT IN AN EFFECT, AND THAT IS THE WHOLE POINT. This began as
 * `useEffect(() => installBrowserErrorLog(), [])` inside a null-rendering `BrowserErrorRecorder`
 * component. A passive effect is flushed AFTER the commit that hydrates the tree, so every
 * `console.error` React emits while hydrating — a hydration mismatch, a render error, a boundary
 * fallback — arrived BEFORE the recorder existed and was never captured. Those are exactly the
 * cases `browserErrorLog.ts` names as its reason for existing, so the recorder missed the case it
 * was built for.
 *
 * 🔴 AND THE TWO HALVES OF THE CAPTURE ARE NOT SYMMETRIC HERE. The network half is retroactive by
 * construction: `observe({ type: 'resource', buffered: true })` replays the entries already in the
 * resource-timing buffer, so installing it late still sees page-load failures. `console.error`
 * leaves no such buffer — an unpatched call is gone the moment it returns — so for the console half
 * "install earlier" is the only available fix, and every millisecond before it is a blind spot.
 *
 * WHAT THIS STILL DOES NOT REACH, stated rather than implied: modules evaluated BEFORE this one.
 * That is Next's own runtime plus whatever `_app.tsx` imports above it, so the remaining window is
 * bounded by this file's position in that import list — not by a React lifecycle phase.
 *
 * 🔴 SSR-SAFE, WHICH IS LOAD-BEARING BECAUSE `_app.tsx` IS EVALUATED ON THE SERVER TOO.
 * `installBrowserErrorLog` returns a no-op uninstaller and touches nothing when there is no
 * `window`, so this call is inert during SSR. Pinned by a node-environment test, so the guard
 * cannot be removed from the other side without a red.
 *
 * Idempotent: the module-scope flag plus the `window` guard inside `installBrowserErrorLog` mean a
 * re-evaluation under Fast Refresh, or any later caller, is a no-op rather than a second wrapper.
 *
 * 🔴 NOT GATED ON THE FEEDBACK AREA FLAG, DELIBERATELY. The area flag governs whether a report can
 * be SUBMITTED; this governs whether there is a buffer in memory to attach if one is. Gating it
 * would mean a reporter who opens the drawer the moment something breaks gets a snapshot of only
 * what happened after the flag resolved.
 *
 * Nothing here is in the request path — see the mechanism note in `browserErrorLog.ts`: `fetch` is
 * not patched, network capture is a passive `PerformanceObserver`, and the `console.error` wrapper
 * delegates to the original before it records.
 */
installBrowserErrorLog();
