/**
 * The route query a store-backed media filter dropdown writes on Apply or Clear: the URL params it
 * moved into the store are dropped (they would outrank it), and `?tags=`, which has no store field,
 * is written from the staged value. `tags: null` leaves the URL's tags alone (a dropdown without
 * the tag filter).
 */
export function appliedRouteQuery<Query extends object>(
  routeQuery: Query,
  { overridden, tags }: { overridden: string[]; tags: number[] | null }
): Query {
  const next = { ...routeQuery } as Record<string, unknown>;
  for (const key of overridden) delete next[key];
  if (tags) {
    if (tags.length) next.tags = tags;
    else delete next.tags;
  }
  return next as Query;
}
