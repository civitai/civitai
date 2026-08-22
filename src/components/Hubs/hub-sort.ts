import type { SortAvailability } from '~/components/Filters/sort-availability';
import { isSortAvailable } from '~/components/Filters/sort-availability';
import { ImageSort } from '~/server/common/enums';
import type { HubSort } from '~/server/schema/user-hub.schema';
import { hubSortSchema } from '~/server/schema/user-hub.schema';

/**
 * A hub is created sorted Newest, but the images sort menu hides Newest and Oldest
 * from anyone who cannot view NSFW — so those viewers were handed a sort they were
 * never offered again. Resolved on read and never written back: regaining NSFW
 * browsing returns the hub to the sort its owner actually chose.
 */
export function resolveHubSort(stored: unknown, availability: SortAvailability): HubSort {
  const sort = hubSortSchema.catch(ImageSort.Newest).parse(stored);
  if (isSortAvailable({ type: 'images', value: sort }, availability)) return sort;

  return (
    hubSortSchema.options.find((value) =>
      isSortAvailable({ type: 'images', value }, availability)
    ) ?? sort
  );
}
