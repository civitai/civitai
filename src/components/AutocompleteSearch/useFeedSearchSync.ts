import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { nextFeedSearchQuery } from '~/components/AutocompleteSearch/autocomplete-query';

/**
 * Search v3: keeps the header bar and the feed's `?query=` in step, on a feed that answers it. Only
 * typing writes the URL; a URL change from elsewhere (first load, the feed's Clear search) re-seeds
 * the bar instead, and `appliedQuery` is what tells the two apart, so neither overwrites the other.
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
  const appliedQuery = useRef<string | undefined>(undefined);
  const typedSinceSeed = useRef(false);

  const apply = (text: string) => {
    if (!enabled || blocked) return;
    const next = nextFeedSearchQuery(router.query, text);
    if (!next) return;
    appliedQuery.current = typeof next.query === 'string' ? next.query : undefined;
    void router.replace({ pathname: router.pathname, query: next }, undefined, { shallow: true });
  };

  useEffect(() => {
    if (!enabled || feedQuery === appliedQuery.current) return;
    appliedQuery.current = feedQuery;
    typedSinceSeed.current = false;
    setSearch(feedQuery ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, feedQuery]);

  useEffect(() => {
    if (typedSinceSeed.current) apply(debouncedSearch);
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
