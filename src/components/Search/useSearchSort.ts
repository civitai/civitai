import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';

/**
 * The URL param holding a search's own sort. Kept apart from the feed's `sort`, which is saved with
 * the viewer's feed filters: a search starts at Best match whatever the feed is sorted by.
 */
export const SEARCH_SORT_PARAM = 'searchSort';

/** The search's sort from the URL, if it is one of `sorts`; absent is Best match. */
export function useSearchSort<T extends string>(sorts: readonly T[]) {
  const router = useRouter();
  const value = router.query[SEARCH_SORT_PARAM];
  const searchSort = sorts.find((x) => x === value);
  const setSearchSort = (next: T | undefined) =>
    void router.replace(
      {
        pathname: router.pathname,
        query: removeEmpty({ ...router.query, [SEARCH_SORT_PARAM]: next }),
      },
      undefined,
      { shallow: true, scroll: false }
    );
  return { searchSort, setSearchSort };
}
