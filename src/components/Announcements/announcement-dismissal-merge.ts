import { useEffect } from 'react';
import { selectLiveDismissals } from '~/utils/dismissal-set';

/**
 * Union the account's dismissals into a device store, intersected with the live ids the caller
 * is showing.
 *
 * The intersection is what keeps each store's own partitioning intact — the cookie's buckets
 * are per announcement type and the creator set is its own store, and the server returns one
 * flat list that knows about neither. It also keeps this out of the way of the prune each
 * consumer already runs against the same live set.
 *
 * Before the live set has loaded the intersection is empty, so this waits without needing a
 * guard of its own.
 *
 * `merge` must write locally only. Routing it back through the dismiss path would echo every
 * merged id straight back to the server it came from.
 */
export function useMergeServerDismissals({
  liveIds,
  serverDismissedIds,
  merge,
}: {
  liveIds: number[];
  serverDismissedIds: number[];
  merge: (ids: number[]) => void;
}) {
  useEffect(() => {
    const toMerge = selectLiveDismissals(serverDismissedIds, liveIds);
    if (toMerge.length) merge(toMerge);
  }, [liveIds, serverDismissedIds, merge]);
}
