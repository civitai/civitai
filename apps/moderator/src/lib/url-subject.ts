/**
 * The identity of what a page is working on, ignoring the params that only move within it.
 *
 * Pages here hold client-side state a moderator is assembling — a selection of images, a set of staged
 * decisions — which must survive paging and must NOT survive changing what is being looked at. Keying
 * that on the whole query string throws the work away on every Next; keying it on the loaded data
 * throws it away when a failed action re-invalidates.
 */
export function subjectKey(url: URL, ignore: string[]): string {
  const params = new URLSearchParams(url.search);
  for (const key of ignore) params.delete(key);
  params.sort();
  return params.toString();
}
