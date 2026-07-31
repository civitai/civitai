import { useCallback, useEffect, useRef, useState } from 'react';
import {
  decideRefreshRetry,
  msUntilExpiry,
  shouldRetainTokenOnFailure,
} from './blockTokenRetry';
import type { BlockInstall, SlotContext } from './types';

interface UseBlockTokenResult {
  token: string | null;
  /** ISO-8601 expiry of the current token. Surfaces to the iframe in
   *  BLOCK_INIT.token.expiresAt so blocks don't have to JWT-decode. */
  expiresAt: string | null;
  error: Error | null;
  pending: boolean;
  /** A6: true when the app's approved manifest declares scopes the viewer has
   *  not granted. The token still mints (with the granted subset); the host
   *  should surface a re-consent prompt for `missingScopes`. */
  needsConsent: boolean;
  /** A6: the consent-gated scopes withheld from the current token. */
  missingScopes: string[];
  /** Advisory maturity signal mirrored from the mint (BLOCK_INIT). The color
   *  domain the token was minted on, or null when unresolved. */
  domain: 'green' | 'blue' | 'red' | null;
  /** Advisory: the bitwise browsing-level ceiling for the domain (SFW on
   *  green/blue, all on red). undefined on legacy responses → fail closed. */
  maxBrowsingLevel: number | undefined;
  /**
   * A bounded automatic re-mint is scheduled after a refresh failure — i.e. the
   * hook has NOT settled. Consumers must not take a destructive action (collapse
   * the slot, tear down a ready page) while this is true: the failure is still
   * being recovered from.
   */
  retrying: boolean;
  /**
   * 🔴 THE FLAG DESTRUCTIVE UI MUST KEY ON. True only when the mint has failed,
   * NO usable token remains, AND no automatic recovery is pending. Derived here
   * rather than left to each consumer so the model slot and the page host cannot
   * disagree about what "the token is gone for good" means (they did: the slot
   * collapsed on any `error`, the page ignored the error entirely once ready).
   */
  terminal: boolean;
  refresh: () => Promise<void>;
}

interface TokenResponse {
  token: string;
  expiresAt: string;
  /** A6: present from the server when the viewer's grant is short of the
   *  app's approved manifest. Older responses omit these → treat as no-op. */
  needsConsent?: boolean;
  missingScopes?: string[];
  /** Advisory maturity signal. Omitted by pre-feature responses → fail closed. */
  domain?: 'green' | 'blue' | 'red' | null;
  maxBrowsingLevel?: number;
}

const REFRESH_LEAD_MS = 2 * 60 * 1000; // refresh 2 minutes before expiry
const RATE_LIMIT_BACKOFF_MS = 60 * 1000; // 1 minute base backoff on HTTP 429
const RATE_LIMIT_JITTER_MS = 15 * 1000; // ±15s jitter — avoids thundering herd
const MIN_REFRESH_MS = 30 * 1000;

// M-1: removed the process-wide in-flight dedup. The shared Promise tied
// to one instance's AbortController collateral-aborted siblings on unmount,
// surfacing as a spurious error in the other still-mounted instances. The
// dedup saved at most one POST per (subject, instance) every ~15 minutes;
// per-instance fetches at that rate are below the per-(user, instance)
// rate limit (60/min) by orders of magnitude.

/**
 * Issues a block-scoped JWT via POST /api/v1/block-tokens and auto-refreshes
 * at T-2 minutes. Returns null while pending; surfaces errors via the `error`
 * field rather than throwing so consumers can render a fallback UI.
 *
 * The context object is intentionally read through a ref so callers can pass
 * inline literals (e.g. `{ slotId, modelId, ... }`) without forcing a token
 * re-issuance on every parent render. Re-issuance is keyed only on the stable
 * `blockInstanceId`. If a caller needs to force a refresh on context change,
 * use the returned `refresh()`.
 */
export function useBlockToken(
  install: BlockInstall,
  context: SlotContext
): UseBlockTokenResult {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState<boolean>(true);
  const [needsConsent, setNeedsConsent] = useState<boolean>(false);
  const [missingScopes, setMissingScopes] = useState<string[]>([]);
  const [domain, setDomain] = useState<'green' | 'blue' | 'red' | null>(null);
  const [maxBrowsingLevel, setMaxBrowsingLevel] = useState<number | undefined>(undefined);
  // A bounded automatic re-mint is scheduled. State (not a ref) because it is
  // part of the returned contract — it drives whether a consumer may take a
  // destructive action — so it has to re-render.
  const [retrying, setRetrying] = useState<boolean>(false);
  // M4 (audit-10): peek the current token via a ref instead of running a
  // side-effect inside a state-updater. React 18 strict-mode calls updaters
  // twice in dev; a counter/increment side-effect there would silently
  // double. Keeping the ref synchronized via the same setter avoids the trap.
  const tokenRef = useRef<string | null>(null);
  // Mirror of `expiresAt` for the failure branch, which runs inside the
  // `requestToken` callback and must not close over stale state to decide
  // whether the held token is still live.
  const expiresAtRef = useRef<string | null>(null);
  // Automatic re-mints already spent in the CURRENT failure episode. Reset to 0
  // on every success, so a token that refreshes cleanly for hours always gets a
  // full budget the next time something breaks.
  const retryAttemptsRef = useRef<number>(0);
  // A request (INCLUDING the 60s jittered 429 pause inside fetchOnce) is in
  // flight. 🔴 The AUTOMATIC callers gate on this so they never abort a live
  // request: `requestToken` begins by aborting the previous controller, and
  // aborting mid-429-pause would immediately re-hit an endpoint that JUST told
  // us to back off — turning a platform-wide rate-limit event into a storm.
  // Manual `refresh()` deliberately keeps abort-and-restart semantics (a
  // consent grant must re-mint NOW, with the new scopes).
  const inFlightRef = useRef<boolean>(false);
  // Timers armed INSIDE `requestToken` need the idle-guarded entry point, which
  // is defined after it. Reading it through a ref (assigned during render, like
  // `contextRef`/`buildInitPayloadRef` below and PageBlockHost's
  // `performRetryRef`) avoids the forward reference AND keeps every automatic
  // path on ONE guarded entry point — three inline copies of the in-flight rule
  // is how they drift.
  const requestTokenIfIdleRef = useRef<() => void>(() => undefined);
  // ONE timer ref for every scheduled follow-up: the success refresh, the
  // failure backoff retry, and the settled-token expiry sweep. They are mutually
  // exclusive by construction, so a single ref means at most one pending timer
  // and the unmount cleanup below provably cannot leak one.
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Absolute Unix-ms moment we should refresh by. Source of truth for the
  // visibility-resume logic — refreshTimeoutRef alone was a poor proxy
  // because the timer's callback can short-circuit on document.hidden and
  // the ref is never cleared, leaving the visibility-resume hook permanently
  // skipping refreshes (audit B2).
  const refreshAtRef = useRef<number>(0);
  // M5 (audit-10): retry-attempt tracking removed. The retry loop already
  // gates on `attempt === 0`, and no read site consults a sticky flag.
  const mountedRef = useRef<boolean>(true);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef<SlotContext>(context);
  contextRef.current = context;

  const requestToken = useCallback(async (): Promise<void> => {
    // 🔴 BAIL BEFORE CLAIMING `abortRef`. This check used to sit just below the
    // claim, which was harmless when nothing tracked in-flight state but is a
    // trap now: a no-op call would take ownership of `abortRef` without ever
    // entering the try/finally, so an actually-in-flight sibling's `finally`
    // would no longer recognise itself as current and would leave `inFlightRef`
    // stuck TRUE — permanently disabling every automatic recovery path, silently.
    // The unmount cleanup already aborts the live controller, so returning here
    // drops nothing.
    if (!mountedRef.current) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // H-3: only flip pending=true when we don't already have a token.
    // On refresh, the iframe should stay mounted with the prior token;
    // unmounting it every 2 minutes (the refresh cadence) was tearing
    // down user-visible state mid-session.
    //
    // M4 (audit-10): read the current token via tokenRef instead of a
    // setToken-updater side-effect (which would double-fire in React 18
    // strict-mode dev).
    if (tokenRef.current == null) setPending(true);
    setError(null);
    // A new attempt is under way, so no timer is pending any more. Clearing this
    // here (rather than only in the failure branch) keeps `retrying` honest for
    // the manual/visibility entry points too.
    setRetrying(false);
    inFlightRef.current = true;

    const instanceId = install.blockInstanceId;
    const fetchOnce = async (signal: AbortSignal): Promise<TokenResponse> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch('/api/v1/block-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal,
          body: JSON.stringify({
            blockInstanceId: instanceId,
            slotContext: contextRef.current,
          }),
        });
        if (res.status === 429 && attempt === 0) {
          // Jittered backoff so multiple host instances retrying in parallel
          // don't all hit the endpoint at the same instant after 60s.
          const jitter = (Math.random() * 2 - 1) * RATE_LIMIT_JITTER_MS;
          await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS + jitter));
          if (signal.aborted) throw new Error('aborted');
          continue;
        }
        if (!res.ok) throw new Error(`block-tokens HTTP ${res.status}`);
        return (await res.json()) as TokenResponse;
      }
      throw new Error('block-tokens unreachable');
    };

    try {
      const data = await fetchOnce(controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      // Recovered — hand the next failure episode a full retry budget.
      retryAttemptsRef.current = 0;
      tokenRef.current = data.token;
      expiresAtRef.current = data.expiresAt;
      setToken(data.token);
      setExpiresAt(data.expiresAt);
      setNeedsConsent(data.needsConsent === true);
      setMissingScopes(Array.isArray(data.missingScopes) ? data.missingScopes : []);
      setDomain(
        data.domain === 'green' || data.domain === 'blue' || data.domain === 'red'
          ? data.domain
          : null
      );
      setMaxBrowsingLevel(
        typeof data.maxBrowsingLevel === 'number' && Number.isFinite(data.maxBrowsingLevel)
          ? data.maxBrowsingLevel
          : undefined
      );
      setPending(false);

      const expiresAtMs = new Date(data.expiresAt).getTime();
      const refreshDelay = Math.max(
        expiresAtMs - Date.now() - REFRESH_LEAD_MS,
        MIN_REFRESH_MS
      );
      refreshAtRef.current = Date.now() + refreshDelay;
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = setTimeout(() => {
        // Clear the ref first so visibility-resume can tell the difference
        // between "timer queued" and "timer fired but skipped." Without this
        // a hidden-tab no-op left the ref pointing at a spent timer ID and
        // the visibility hook would permanently skip refreshes.
        refreshTimeoutRef.current = null;
        // Pause refresh while tab is hidden — visibilitychange picks it up.
        if (typeof document !== 'undefined' && document.hidden) return;
        requestTokenIfIdleRef.current();
      }, refreshDelay);
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current) return;
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setPending(false);

      // ── REFRESH-FAILURE RECOVERY ────────────────────────────────────────────
      // 🔴 Before this, the failure branch set `error`, nulled the token and
      // scheduled NOTHING — the success path was the only place a timer was ever
      // armed, so the only route back was the user hiding and re-showing the tab.
      //
      // (1) KEEP a still-live token. A failed REFRESH says nothing about the
      //     credential already in hand (refresh runs at T-2min, so it normally
      //     has ~2 minutes left). Retaining it keeps the iframe MOUNTED — no lost
      //     in-progress state, and no remount, which is what used to emit a
      //     second impression beacon for one logical view.
      const now = Date.now();
      const retained = shouldRetainTokenOnFailure({
        token: tokenRef.current,
        expiresAt: expiresAtRef.current,
        now,
      });
      if (!retained) {
        tokenRef.current = null;
        expiresAtRef.current = null;
        setToken(null);
        setExpiresAt(null);
      }

      // (2) Schedule a BOUNDED automatic re-mint, or settle. Never unbounded:
      //     /api/v1/block-tokens is rate-limited 60/min per (user, instance).
      const decision = decideRefreshRetry({ attempts: retryAttemptsRef.current });
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = null;

      if (decision.kind === 'retry') {
        retryAttemptsRef.current += 1;
        // refreshAtRef is the SINGLE source of truth for "when should we next
        // try". Pointing it at the backoff moment is what stops `visibilitychange`
        // from double-firing alongside this timer: the visibility handler skips
        // while we are still inside the backoff window.
        refreshAtRef.current = now + decision.delayMs;
        setRetrying(true);
        refreshTimeoutRef.current = setTimeout(() => {
          refreshTimeoutRef.current = null;
          // Same hidden-tab pause as the success refresh; visibilitychange resumes.
          if (typeof document !== 'undefined' && document.hidden) return;
          // Through the ref, like the success timer above — `requestTokenIfIdle`
          // is declared below, and one indirection for both timers keeps them
          // from drifting apart.
          requestTokenIfIdleRef.current();
        }, decision.delayMs);
        return;
      }

      // SETTLED — the automatic budget is spent. Leave refreshAtRef in the past
      // so the USER-driven escape hatches still work unchanged (`visibilitychange`
      // and an explicit `refresh()`); we simply stop trying on our own.
      refreshAtRef.current = now;
      setRetrying(false);

      // 🔴 One loose end the settle would otherwise leave: a token RETAINED at the
      // moment we stopped retrying is never re-evaluated (no further failure will
      // run the check above), so the host would hold it past its expiry and the
      // block would quietly 401 — exactly the page-host half of the defect. Arm a
      // one-shot sweep at the expiry so the terminal state becomes visible then.
      if (retained) {
        const ttl = msUntilExpiry(expiresAtRef.current, now);
        if (ttl !== null) {
          refreshTimeoutRef.current = setTimeout(() => {
            refreshTimeoutRef.current = null;
            if (!mountedRef.current) return;
            tokenRef.current = null;
            expiresAtRef.current = null;
            setToken(null);
            setExpiresAt(null);
          }, ttl);
        }
      }
    } finally {
      // Only the CURRENT request may clear the flag — a newer request that
      // aborted this one has already set it for itself.
      if (abortRef.current === controller) inFlightRef.current = false;
    }
  }, [install.blockInstanceId]);

  /**
   * The entry point every AUTOMATIC caller uses (scheduled refresh, failure
   * backoff, visibility resume).
   *
   * 🔴 It refuses to start while a request is in flight. `requestToken` opens by
   * aborting the previous controller, and `fetchOnce` handles HTTP 429 by
   * sleeping ~60s (jittered) before its single in-band retry. Without this guard
   * an automatic caller firing during that pause would abort it and immediately
   * re-hit the endpoint that had just asked us to back off. Skipping is safe and
   * self-healing: the in-flight request either succeeds (rescheduling the normal
   * refresh) or fails (scheduling the next bounded backoff).
   */
  const requestTokenIfIdle = useCallback(() => {
    if (inFlightRef.current) return;
    void requestToken();
  }, [requestToken]);
  requestTokenIfIdleRef.current = requestTokenIfIdle;

  useEffect(() => {
    mountedRef.current = true;
    void requestToken();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [requestToken]);

  // Re-fetch when the tab becomes visible — pairs with the document.hidden
  // pause in the scheduled refresh path. Catches the case where a token's
  // refresh window elapsed while the tab was backgrounded.
  //
  // Audit B2: gate on the absolute refresh moment, not the timer ref. The
  // ref alone gave false "still scheduled" answers because the hidden-tab
  // path short-circuits without rescheduling. With refreshAtRef we know
  // whether we're past the refresh moment regardless of timer state.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.hidden || !mountedRef.current) return;
      // 🔴 NO DOUBLE-FIRE WITH THE FAILURE BACKOFF. `refreshAtRef` now also
      // carries the pending retry moment, so while we are inside a backoff
      // window this is a no-op and the armed timer remains the single attempt.
      // Past the moment (including the settled case, where refreshAtRef is left
      // in the past) this stays the user-driven escape hatch it has always been.
      if (refreshAtRef.current === 0 || Date.now() >= refreshAtRef.current) {
        // Guarded: must never abort an in-flight 429 backoff. See requestTokenIfIdle.
        requestTokenIfIdle();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [requestTokenIfIdle]);

  const refresh = useCallback(async () => {
    await requestToken();
  }, [requestToken]);

  return {
    token,
    expiresAt,
    error,
    pending,
    needsConsent,
    missingScopes,
    domain,
    maxBrowsingLevel,
    retrying,
    // The mint failed, nothing usable is left, and no automatic attempt is
    // coming. This — NOT a bare `error` — is what a consumer may act
    // destructively on.
    terminal: error != null && token == null && !retrying,
    refresh,
  };
}
