import { GENERATOR_RESTRICTIONS_PATH, SCAM_RESTRICTIONS_PATH } from '$lib/restriction-types';
import {
  LEGACY_FLAG_APPEALS_PATH,
  LEGACY_FLAGS_MATCHES_PATH,
  LEGACY_FLAGS_REVIEW_PATH,
  LEGACY_HELD_DETECTIONS_PATH,
  LEGACY_MINOR_HASH_PATH,
  MODEL_FLAGS_APPEALS_PATH,
  MODEL_FLAGS_AUTO_PATH,
  MODEL_FLAGS_NEEDS_REVIEW_PATH,
} from '$lib/minor-flags/paths';
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

/** `dest` with the request's params minus `drop`, plus `set` (which wins over a same-named param). */
function carryTo(url: URL, dest: string, drop: string, set?: Record<string, string>): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete(drop);
  for (const [key, value] of Object.entries(set ?? {})) params.set(key, value);
  const search = params.toString();
  return search ? `${dest}?${search}` : dest;
}

/** Model Flags' tabs follow enforcement state: a flag automation applied waits in Auto-flagged, a lead
 *  nothing was applied for (a held detection, a file match) in Needs review. */
const NEEDS_REVIEW_DETECTIONS = { source: 'text-scan' };
const NEEDS_REVIEW_MATCHES = { source: 'hash' };

function minorHashMatchesTarget(url: URL): string {
  const tab = url.searchParams.get('tab');
  if (tab === 'appeals') return carryTo(url, MODEL_FLAGS_APPEALS_PATH, 'tab');
  if (tab === 'auto') return carryTo(url, MODEL_FLAGS_AUTO_PATH, 'tab', { source: 'hash' });
  return carryTo(url, MODEL_FLAGS_NEEDS_REVIEW_PATH, 'tab', NEEDS_REVIEW_MATCHES);
}

function flagAppealsTarget(url: URL): string {
  return url.searchParams.get('view') === 'redetected'
    ? carryTo(url, MODEL_FLAGS_NEEDS_REVIEW_PATH, 'view', NEEDS_REVIEW_DETECTIONS)
    : carryTo(url, MODEL_FLAGS_APPEALS_PATH, 'view');
}

/** The old Flagged tab held applied flags and held re-detections; only the latter moved on. */
function flagsReviewTarget(url: URL): string {
  return url.searchParams.get('source') === 'redetected'
    ? carryTo(url, MODEL_FLAGS_NEEDS_REVIEW_PATH, '', NEEDS_REVIEW_DETECTIONS)
    : carryTo(url, MODEL_FLAGS_AUTO_PATH, '');
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
  // 2026-11: Minor Hash Matches, Model Flag Appeals and Held Detections became the tabs of Model Flags.
  { from: LEGACY_MINOR_HASH_PATH, to: minorHashMatchesTarget },
  { from: LEGACY_FLAG_APPEALS_PATH, to: flagAppealsTarget },
  {
    from: LEGACY_HELD_DETECTIONS_PATH,
    to: (url) => carryTo(url, MODEL_FLAGS_NEEDS_REVIEW_PATH, 'source', NEEDS_REVIEW_DETECTIONS),
  },
  // 2026-11: Flagged and File matches regrouped by whether the flag is applied.
  { from: LEGACY_FLAGS_REVIEW_PATH, to: flagsReviewTarget },
  {
    from: LEGACY_FLAGS_MATCHES_PATH,
    to: (url) => carryTo(url, MODEL_FLAGS_NEEDS_REVIEW_PATH, 'source', NEEDS_REVIEW_MATCHES),
  },
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
