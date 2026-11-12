import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { nextFeedSearchQuery } from '~/components/AutocompleteSearch/autocomplete-query';

const MIN_TYPED_QUERY_LENGTH = 2;

/**
 * Search v3: keeps the header bar and the feed's `?query=` in step, on a feed that answers it. Only
 * typing writes the URL; a URL change from elsewhere (first load, Back, the feed's Clear search)
 * re-seeds the bar instead.
 *
 * Our own writes are told apart by VALUE, against every write still in flight, not just the last:
 * a second write can go out before the router shows the first, and a last-write-only check would
 * then re-seed the bar with that stale first value. A URL value we did not write is external, even
 * one equal to where we started (Back), so it re-seeds and drops whatever was in flight.
 */
export function useFeedSearchSync({
  enabled,
  debouncedSearch,
  setSearch,
  blocked,
}: {
  enabled: boolean;
  debouncedSearch: string;
  setSearch: (value: string) => void;
  /** A query the bar refuses (illegal, profane, blocked words) never reaches the feed. */
  blocked: boolean;
}) {
  const router = useRouter();
  const feedQuery = typeof router.query.query === 'string' ? router.query.query : undefined;
  const inFlight = useRef<(string | undefined)[]>([]);
  const typedSinceSeed = useRef(false);
  const lastSeen = useRef<string | undefined>(undefined);

  const apply = (text: string) => {
    if (!enabled || blocked) return;
    const next = nextFeedSearchQuery(router.query, text);
    if (!next) return;
    inFlight.current.push(typeof next.query === 'string' ? next.query : undefined);
    void router.replace({ pathname: router.pathname, query: next }, undefined, { shallow: true });
  };

  useEffect(() => {
    if (!enabled || feedQuery === lastSeen.current) return;
    lastSeen.current = feedQuery;
    const ours = inFlight.current.indexOf(feedQuery);
    if (ours >= 0) {
      inFlight.current.splice(0, ours + 1);
      return;
    }
    inFlight.current = [];
    typedSinceSeed.current = false;
    setSearch(feedQuery ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, feedQuery]);

  useEffect(() => {
    // Each applied query is a semantic search; a one-letter one finds nothing worth the call.
    // Emptying the bar still applies at once, and so does Enter.
    const text = debouncedSearch.trim();
    if (typedSinceSeed.current && (!text || text.length >= MIN_TYPED_QUERY_LENGTH))
      apply(debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, debouncedSearch, blocked]);

  return {
    /** Call on every edit the user makes; until then the bar only mirrors the URL. */
    markTyped: () => {
      typedSinceSeed.current = true;
    },
    /** Enter: apply now rather than after the debounce. */
    applyNow: apply,
  };
}
