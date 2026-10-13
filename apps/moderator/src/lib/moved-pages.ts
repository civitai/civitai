import { GENERATOR_RESTRICTIONS_PATH, SCAM_RESTRICTIONS_PATH } from '$lib/restriction-types';
import { FLAG_APPEALS_PATH, MINOR_HASH_PATH } from '$lib/minor-flags/paths';

/** `dest` with the request's params, minus the one that selected the view that moved. */
export function redirectWithoutParam(url: URL, key: string, dest: string): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete(key);
  const search = params.toString();
  return search ? `${dest}?${search}` : dest;
}

const MOVED_VIEWS = [
  { from: GENERATOR_RESTRICTIONS_PATH, key: 'type', value: 'scam', to: SCAM_RESTRICTIONS_PATH },
  { from: MINOR_HASH_PATH, key: 'tab', value: 'appeals', to: FLAG_APPEALS_PATH },
] as const;

/**
 * Where an old bookmark to a view that became its own page now lives, or null. Applied before the
 * grant check, so the destination's own grant decides rather than the old page's.
 */
export function movedViewTarget(url: URL): string | null {
  const moved = MOVED_VIEWS.find(
    (m) => url.pathname === m.from && url.searchParams.get(m.key) === m.value
  );
  return moved ? redirectWithoutParam(url, moved.key, moved.to) : null;
}
