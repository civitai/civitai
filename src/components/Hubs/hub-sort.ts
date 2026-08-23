import type { SortAvailability } from '~/components/Filters/sort-availability';
import { resolveFeedSort } from '~/components/Filters/sort-availability';
import { ImageSort } from '~/server/common/enums';
import type { HubSort } from '~/server/schema/user-hub.schema';
import { hubSortSchema } from '~/server/schema/user-hub.schema';

/**
 * A hub carries its own stored sort, so it can hold one this viewer is not offered
 * — the sort is theirs, the availability is the domain's. Resolved on read and
 * never written back, so regaining NSFW browsing returns the hub to the sort its
 * owner chose.
 */
export function resolveHubSort(stored: unknown, availability: SortAvailability): HubSort {
  const sort = hubSortSchema.catch(ImageSort.Newest).parse(stored);
  return resolveFeedSort({ type: 'images', value: sort }, availability);
}

/** What a hub this viewer creates is sorted by, so it is never stored on one they cannot pick. */
export function defaultHubSort(availability: SortAvailability): HubSort {
  return resolveHubSort(ImageSort.Newest, availability);
}
