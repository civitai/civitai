import { GENERATOR_RESTRICTIONS_PATH, SCAM_RESTRICTIONS_PATH } from '$lib/restriction-types';
import { FLAG_APPEALS_PATH, HELD_DETECTIONS_PATH, MINOR_HASH_PATH } from '$lib/minor-flags/paths';
import { postReportUrl, userReportUrl } from '$lib/entity-url';
import { SUSPECT_TABS } from '../routes/reports/user/tabs';

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
  { from: FLAG_APPEALS_PATH, key: 'view', value: 'redetected', to: HELD_DETECTIONS_PATH },
] as const;

/** `?user=&tab=` became the path: `/reports/user/<id>/<tab>`. A tab the route does not have is dropped
 *  rather than sent to a 404. */
function userReportsTarget(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  const user = Number(params.get('user'));
  const tab = params.get('tab') ?? undefined;
  params.delete('user');
  params.delete('tab');
  const known = tab && (SUSPECT_TABS as readonly string[]).includes(tab) ? tab : undefined;
  const path = Number.isInteger(user) && user > 0 ? userReportUrl(user, known) : '/reports/user';
  return params.size ? `${path}?${params}` : path;
}

/** `?post=` became the path: `/reports/post/<id>`. */
function postReportsTarget(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  const post = Number(params.get('post'));
  params.delete('post');
  const path = Number.isInteger(post) && post > 0 ? postReportUrl(post) : '/reports/post';
  return params.size ? `${path}?${params}` : path;
}

/**
 * Whole pages that moved, with the params that became path segments carried into the path. Here
 * rather than as a redirect in each old route's `load`: that runs AFTER the grant check, which gates
 * the old path on whatever group it sat in — the Retool group, the Images group — so a moderator who
 * can open the new page but holds nothing in the old group was bounced to the dashboard instead.
 */
const MOVED_PAGES: { from: string; to: (url: URL) => string }[] = [
  // 2026-10-14 / 15: into the Reports section, each on the report-queue pattern.
  { from: '/retool/user-reports', to: userReportsTarget },
  { from: '/retool/post-reports', to: postReportsTarget },
  // 2026-10-15: the reported-image grid replaced the image-report table. Its rating filter and
  // cursor mean the same there.
  { from: '/images/reported', to: (url) => `/reports/image${url.search}` },
];

/**
 * Where an old bookmark to a view that became its own page now lives, or null. Applied before the
 * grant check, so the destination's own grant decides rather than the old page's.
 */
export function movedViewTarget(url: URL): string | null {
  const page = MOVED_PAGES.find((m) => url.pathname === m.from);
  if (page) return page.to(url);
  const moved = MOVED_VIEWS.find(
    (m) => url.pathname === m.from && url.searchParams.get(m.key) === m.value
  );
  return moved ? redirectWithoutParam(url, moved.key, moved.to) : null;
}
