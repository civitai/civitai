import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import {
  nextFeedSearchQuery,
  parseFeedSearch,
} from '~/components/AutocompleteSearch/autocomplete-query';

/**
 * Search v3: keeps the header bar and the feed's `?query=` in step, on a feed that answers it. The
 * bar writes the URL only when its text is committed (Enter, blur, the clear button), never as you
 * type: each applied query is a semantic search, and the service can't take one per keystroke. Each
 * commit pushes a history entry; a URL change from elsewhere (first load, Back to the previous
 * search, the feed's Clear search) re-seeds the bar instead.
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
  /** The bar's text after the debounce the refusal checks read. */
  debouncedSearch: string;
  setSearch: (value: string) => void;
  /** A query the bar refuses (illegal, profane, blocked words) never reaches the feed. */
  blocked: boolean;
}) {
  const router = useRouter();
  const feedQuery = typeof router.query.query === 'string' ? router.query.query : undefined;
  const inFlight = useRef<(string | undefined)[]>([]);
  const lastSeen = useRef<string | undefined>(undefined);
  const typedUsername = useRef<string | undefined>(undefined);
  // A committed text waits here until the debounce, and so the refusal checks, have caught up to it.
  const committed = useRef<string | undefined>(undefined);

  const apply = (text: string) => {
    // An empty bar can't be refused: it is checked against the last text, not its own.
    if (!enabled || (blocked && text)) return;
    const next = nextFeedSearchQuery(router.query, text, typedUsername.current);
    if (!next) return;
    typedUsername.current = parseFeedSearch(text).username;
    inFlight.current.push(typeof next.query === 'string' ? next.query : undefined);
    void router.push({ pathname: router.pathname, query: next }, undefined, { shallow: true });
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
    committed.current = undefined;
    typedUsername.current = undefined;
    setSearch(feedQuery ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, feedQuery]);

  useEffect(() => {
    if (committed.current === undefined || committed.current !== debouncedSearch) return;
    committed.current = undefined;
    apply(debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, debouncedSearch, blocked]);

  return {
    /** Enter, blur or clear: apply `text` to the feed once the refusal checks have read it. */
    commit: (text: string) => {
      if (text && text !== debouncedSearch) {
        committed.current = text;
        return;
      }
      committed.current = undefined;
      apply(text);
    },
  };
}
