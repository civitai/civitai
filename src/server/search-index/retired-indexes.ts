import { IMAGES_SEARCH_INDEX, METRICS_IMAGES_SEARCH_INDEX } from '~/server/common/constants';

// Kept a leaf so the search-token route and the site-search endpoint can read it without loading
// the index processors.

// Search indexes we no longer serve. Browser search tokens do not grant them, and the site-search
// endpoint refuses them. This list does not drive any processor: IMAGES_SEARCH_INDEX has none, and
// both METRICS_IMAGES_SEARCH_INDEX processors are no-op stubs that hardcode `retired: true`.
// Restoring one means removing it here, writing a real processor (or dropping the hardcoded flag),
// and re-running its reset.
// METRICS_IMAGES_SEARCH_INDEX: the feeds index (`metrics_images_v1`), replaced by the feed service.
export const RETIRED_SEARCH_INDEXES: readonly string[] = [
  IMAGES_SEARCH_INDEX,
  METRICS_IMAGES_SEARCH_INDEX,
];

export const isRetiredSearchIndex = (index: string) => RETIRED_SEARCH_INDEXES.includes(index);
