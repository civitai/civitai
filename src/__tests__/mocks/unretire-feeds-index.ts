import { METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import type * as RetiredIndexes from '~/server/search-index/retired-indexes';

/**
 * `vi.mock('~/server/search-index/retired-indexes', unretireFeedsIndex)` — the feeds index
 * (`metrics_images_v1`) reads as live, every other retired index stays retired.
 *
 * Its readers answer an empty page while it is retired. The suites that pin the Meilisearch read
 * path, kept in the code for a restore, need it un-retired to reach that path.
 */
export async function unretireFeedsIndex(
  importOriginal: <T>() => Promise<T>
): Promise<typeof RetiredIndexes> {
  const actual = await importOriginal<typeof RetiredIndexes>();
  return {
    ...actual,
    isRetiredSearchIndex: (index: string) =>
      index !== METRICS_IMAGES_SEARCH_INDEX && actual.isRetiredSearchIndex(index),
  };
}
