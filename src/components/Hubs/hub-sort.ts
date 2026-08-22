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
 * Falls back to Most Reactions rather than to the next sort in the list. Oldest is
 * withheld wherever Newest is, and for the same reason, so reaching for it would put
 * the viewer back in front of what this rule exists to keep away.
 *
 * Resolved on read and never written back, so regaining NSFW browsing returns the hub
 * to the sort its owner chose.
 */
export function resolveHubSort(stored: unknown, availability: SortAvailability): HubSort {
  const sort = hubSortSchema.catch(ImageSort.Newest).parse(stored);
  const offered = (value: HubSort) => isSortAvailable({ type: 'images', value }, availability);

  if (offered(sort)) return sort;
  if (offered(ImageSort.MostReactions)) return ImageSort.MostReactions;
  return hubSortSchema.options.find(offered) ?? sort;
}

/** What a hub this viewer creates should be sorted by, so it is never stored as one they cannot pick. */
export function defaultHubSort(availability: SortAvailability): HubSort {
  return resolveHubSort(ImageSort.Newest, availability);
}
