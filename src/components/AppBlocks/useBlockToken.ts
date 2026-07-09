import { useCallback, useEffect, useRef, useState } from 'react';
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
  // M4 (audit-10): peek the current token via a ref instead of running a
  // side-effect inside a state-updater. React 18 strict-mode calls updaters
  // twice in dev; a counter/increment side-effect there would silently
  // double. Keeping the ref synchronized via the same setter avoids the trap.
  const tokenRef = useRef<string | null>(null);
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
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (!mountedRef.current) return;
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
      tokenRef.current = data.token;
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
        void requestToken();
      }, refreshDelay);
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current) return;
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      tokenRef.current = null;
      setToken(null);
      setExpiresAt(null);
      setPending(false);
    }
  }, [install.blockInstanceId]);

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
      if (refreshAtRef.current === 0 || Date.now() >= refreshAtRef.current) {
        void requestToken();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [requestToken]);

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
    refresh,
  };
}
