import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';

/** The URL param naming the query the viewer chose to search as typed, without spelling correction. */
export const SEARCH_AS_TYPED_PARAM = 'asTyped';

/**
 * "Search instead for <query>": `asTyped` is set while the feed's query is the one the viewer chose
 * to search uncorrected. The param holds that query, so a new search is corrected again.
 */
export function useSearchAsTyped(query: string | undefined) {
  const router = useRouter();
  const value = router.query[SEARCH_AS_TYPED_PARAM];
  const asTyped = !!query && value === query;
  const searchAsTyped = () => {
    if (!query) return;
    void router.push(
      {
        pathname: router.pathname,
        query: removeEmpty({ ...router.query, [SEARCH_AS_TYPED_PARAM]: query }),
      },
      undefined,
      { shallow: true }
    );
  };
  return { asTyped, searchAsTyped };
}

/** The search input's spelling flag: off only while the viewer searches the query as typed. */
export const spellcheckFor = (asTyped: boolean) => (asTyped ? { spellcheck: false as const } : {});
