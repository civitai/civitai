import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';

// Kept a leaf so the search-token route and the site-search endpoint can read it without loading
// the index processors.

// Search indexes we no longer serve. Their processors skip every write and sync, browser search
// tokens do not grant them, and the site-search endpoint refuses them. Restoring one means removing
// it here and re-running its reset.
export const RETIRED_SEARCH_INDEXES: readonly string[] = [IMAGES_SEARCH_INDEX];

export const isRetiredSearchIndex = (index: string) => RETIRED_SEARCH_INDEXES.includes(index);
