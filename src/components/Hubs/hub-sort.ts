import type { SortAvailability } from '~/components/Filters/sort-availability';
import { isSortAvailable } from '~/components/Filters/sort-availability';
import { ImageSort } from '~/server/common/enums';
import type { HubSort } from '~/server/schema/user-hub.schema';
import { hubSortSchema } from '~/server/schema/user-hub.schema';

/**
 * The images sort menu hides Newest and Oldest from viewers who cannot view NSFW,
 * because a freshly posted image may not be rated yet. A hub stored as Newest handed
 * those viewers a sort they were never offered again.
 *
 * Most Reactions rather than the next sort in the list: Oldest is withheld wherever
 * Newest is and for the same reason, so reaching for it would put the viewer back in
 * front of what the rule exists to keep away. Most Reactions is never itself withheld,
 * which the tests pin — if that changes, this hands back a sort the menu will not show.
 *
 * Resolved on read and never written back, so regaining NSFW browsing returns the hub
 * to the sort its owner chose.
 */
export function resolveHubSort(stored: unknown, availability: SortAvailability): HubSort {
  const sort = hubSortSchema.catch(ImageSort.Newest).parse(stored);
  if (isSortAvailable({ type: 'images', value: sort }, availability)) return sort;

  return ImageSort.MostReactions;
}

/** What a hub this viewer creates is sorted by, so it is never stored on one they cannot pick. */
export function defaultHubSort(availability: SortAvailability): HubSort {
  return resolveHubSort(ImageSort.Newest, availability);
}
