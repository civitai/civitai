// Client-side URL mutation for filter controls. The server twin is `$lib/server/query.ts`, which parses
// what these write.
//
// Nine pages hand-rolled this, and two had already drifted apart on the two decisions that matter:
// whether an empty string deletes a param, and whether a cleared multi-value filter keeps an empty
// param. The second is not cosmetic — an absent `?status=` falls back to a page's DEFAULT set, so a
// writer that deletes on clear silently reapplies the default and reads as the filter being ignored.

/** Set or delete single-valued params. `null`, `undefined` and `''` all DELETE — a filter control's
 *  empty state is "not filtering", never "match the empty string". */
export function urlWith(
  url: URL,
  params: Record<string, string | number | null | undefined>
): string {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') next.searchParams.delete(key);
    else next.searchParams.set(key, String(value));
  }
  return next.pathname + next.search;
}

/**
 * Replace one repeated param with `values`.
 *
 * `emptyMeansAll` decides what an empty selection writes, and it must match how the page's `load`
 * reads it. Pages that treat an absent param as a default set (report queues) need `true`, so the
 * cleared state survives as `?key=` and says "all" out loud. Pages whose absent param already means
 * "no filter" need `false`, so clearing leaves a clean URL.
 */
export function urlWithMulti(
  url: URL,
  key: string,
  values: string[],
  opts: { emptyMeansAll?: boolean } = {}
): string {
  const next = new URL(url);
  next.searchParams.delete(key);
  if (values.length === 0) {
    if (opts.emptyMeansAll) next.searchParams.set(key, '');
  } else {
    for (const value of values) next.searchParams.append(key, value);
  }
  return next.pathname + next.search;
}
