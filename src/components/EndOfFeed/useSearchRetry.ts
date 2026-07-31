import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import { queryClient } from '~/utils/trpc';

export const SEARCH_RETRY_MAX_ATTEMPTS = 10;
const SEARCH_RETRY_MAX_DELAY_MS = 60_000;
const SEARCH_RETRY_BASE_DELAY_MS = 2000;
// Slow-fetch thresholds. Bad pods in production can leave a request hanging
// for tens of seconds before failing, so we show a "taking a while" banner
// after SLOW_THRESHOLD_MS and abort at ABORT_THRESHOLD_MS to force a retry.
const SEARCH_SLOW_THRESHOLD_MS = 3_000;
const SEARCH_ABORT_THRESHOLD_MS = 8_000;

// Dev helper: simulate a transient search failure on the client so the retry UI
// can be tested without touching the backend. Enable via browser console:
//   localStorage.debugSearchRetry = '3000'    // base delay in ms
//   localStorage.debugSearchRetryAfter = '1'  // trigger after N successful pages
// To disable: localStorage.removeItem('debugSearchRetry')
//
// When active, callers MUST block further fetches — otherwise real requests
// keep succeeding, more items load, and the retry counter resets every cycle.
export function useDebugSearchRetry(pagesLoaded: number) {
  if (typeof window === 'undefined') return { delayMs: 0, active: false };
  const raw = window.localStorage.getItem('debugSearchRetry');
  if (!raw) return { delayMs: 0, active: false };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return { delayMs: 0, active: false };
  const triggerAfter = Number(window.localStorage.getItem('debugSearchRetryAfter') ?? '1');
  if (pagesLoaded < triggerAfter) return { delayMs: 0, active: false };
  return { delayMs: parsed, active: true };
}

export type UseSearchRetryOptions = {
  // Count that grows when a page loads successfully. Must be the RAW fetched
  // count, not a post-filter count: a page that arrives and then filters down to
  // nothing would otherwise never reset the attempt counter, so a healthy backend
  // would burn all SEARCH_RETRY_MAX_ATTEMPTS.
  itemCount: number;
  isFetching: boolean;
  isError: boolean;
  refetch: () => unknown;
  fetchNextPage: () => unknown;
  infiniteQueryKey: QueryKey;
  // Identity must change exactly when the query changes (a new query is a fresh
  // slate for the attempt counter). Pass a memoized value, not a fresh array, or
  // the reset fires every render and flattens the backoff.
  resetKey: unknown;
  debugRetryActive?: boolean;
  debugDelayMs?: number;
};

/**
 * Bounded retry-with-backoff state for an infinite feed whose backend can fail or
 * hang transiently. Pairs with SearchRetryBanner, which owns the countdown and
 * calls `handleRetry` when it reaches zero.
 *
 * Callers must render the banner INSTEAD of their InViewLoader while `isRetrying`.
 * Leaving the loader mounted gives you two independent retry drivers, and its own
 * re-fire loop is unbounded: `fetchNextPage` resolves rather than rejects on error,
 * so the sentinel stays in view and fires again every `loadTimeout`.
 */
export function useSearchRetry({
  itemCount,
  isFetching,
  isError,
  refetch,
  fetchNextPage,
  infiniteQueryKey,
  resetKey,
  debugRetryActive = false,
  debugDelayMs = 0,
}: UseSearchRetryOptions) {
  const [retryAttempt, setRetryAttempt] = useState(0);
  const prevItemCount = useRef(itemCount);

  // Reset retry attempt counter whenever new items successfully load.
  useEffect(() => {
    if (itemCount > prevItemCount.current) {
      prevItemCount.current = itemCount;
      if (retryAttempt !== 0) setRetryAttempt(0);
    } else {
      prevItemCount.current = itemCount;
    }
  }, [itemCount, retryAttempt]);

  // Reset retry state when the query changes (new query = fresh slate).
  useEffect(() => {
    setRetryAttempt(0);
  }, [resetKey]);

  const [isSlow, setIsSlow] = useState(false);

  // Depend on retryAttempt so every retry restarts the slow timer even when
  // isFetching doesn't visibly transition through false (cancel + refetch in
  // quick succession can collapse into a single `true` state from React's
  // perspective, leaving the effect stale).
  useEffect(() => {
    if (!isFetching) {
      setIsSlow(false);
      return;
    }
    setIsSlow(false);
    const t = setTimeout(() => setIsSlow(true), SEARCH_SLOW_THRESHOLD_MS);
    return () => clearTimeout(t);
  }, [isFetching, retryAttempt]);

  const handleRetry = useCallback(async () => {
    const wasSlow = isSlow;
    if (wasSlow) setIsSlow(false);
    // After exhaustion, manual retry resets the attempt counter for a fresh cycle.
    setRetryAttempt((prev) => (prev >= SEARCH_RETRY_MAX_ATTEMPTS ? 0 : prev + 1));
    // In debug mode we deliberately skip the real fetch so the retry UI can
    // cycle faithfully — otherwise real fetches succeed, more items load,
    // and the retry counter resets every cycle.
    if (debugRetryActive) return;
    // Slow-fetch path: await cancel BEFORE firing the replacement fetch.
    // Without await, React Query can queue the new fetch behind the in-flight
    // one instead of aborting it, so both end up running to completion.
    // cancelQueries also does NOT surface as an error, so we have to kick the
    // replacement fetch off ourselves.
    if (wasSlow) {
      await queryClient.cancelQueries({ queryKey: infiniteQueryKey });
    }
    // Use refetch when there are no pages yet (initial-load failure);
    // fetchNextPage retries the next page when prior pages already succeeded.
    if (itemCount === 0) refetch();
    else fetchNextPage();
  }, [fetchNextPage, refetch, debugRetryActive, itemCount, isSlow, infiniteQueryKey]);

  const isRetrying = isError || debugRetryActive || isSlow;
  const baseDelay = debugRetryActive ? debugDelayMs : SEARCH_RETRY_BASE_DELAY_MS;
  const retryDelay = isSlow
    ? SEARCH_ABORT_THRESHOLD_MS - SEARCH_SLOW_THRESHOLD_MS
    : isError || debugRetryActive
    ? Math.min(baseDelay * Math.pow(2, retryAttempt), SEARCH_RETRY_MAX_DELAY_MS)
    : 0;

  // In debug mode we block real fetches so isFetching never toggles — treat it
  // as countdown-active always. For real errors, the countdown pauses while a
  // retry request is in flight so we don't queue up concurrent duplicates.
  // When slow, we force the countdown on so the abort timer displays.
  const countdownActive = debugRetryActive || !isFetching || isSlow;

  return {
    isRetrying,
    isSlow,
    retryAttempt,
    retryDelay,
    countdownActive,
    handleRetry,
    maxAttempts: SEARCH_RETRY_MAX_ATTEMPTS,
  };
}
