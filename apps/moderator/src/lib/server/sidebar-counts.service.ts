import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getImageReviewCounts } from './image-review.service';

// Triage counts shown as sidebar badges, keyed to NavLink.countKey. Per-mode `/images` counts (minor, poi,
// tag, newUser, modRule, remixSource) plus `imageTags`, `appeals`, and `reported`. A badge should mean
// "this much needs action", so slow backlogs (ingestion errors ~50k) get none. Most are cheap + index-backed;
// `reported` is ~270ms (rides the Report(status) partial index) but streamed, so it never blocks render.
export type SidebarCounts = Record<string, number>;

// The layout load runs on every navigation, so memoize briefly (counts move slowly) and stream the promise
// rather than blocking render — one process-wide refresh per window, most reads instant.
const TTL_MS = 60_000;
let cache: { at: number; value: Promise<SidebarCounts> } | null = null;

export function getSidebarCounts(now = Date.now()): Promise<SidebarCounts> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = fetchCounts();
  cache = { at: now, value };
  // Don't cache a rejection — let the next navigation retry.
  value.catch(() => {
    if (cache?.value === value) cache = null;
  });
  return value;
}

async function fetchCounts(): Promise<SidebarCounts> {
  const [modes, imageTags, appeals, reported] = await Promise.all([
    // Per-needsReview-value counts (minor/poi/tag/…/csam) — keys already match the mode countKeys.
    getImageReviewCounts(),
    // The image-tags queue: images with a needsReview moderation tag. Bitmask predicates written to match
    // the `TagsOnImageNew_needsReview_idx` partial index exactly (bit 9 set, bit 10 clear).
    dbRead
      .selectFrom('TagsOnImageNew')
      .select((eb) => eb.fn.count('imageId').distinct().as('count'))
      .where(sql<boolean>`((attributes >> 9)::integer & 1) = 1`)
      .where(sql<boolean>`((attributes >> 10)::integer & 1) <> 1`)
      .executeTakeFirst(),
    // Appeals — its own count (getImageReviewCounts excludes 'appeal'). Rides Image_needsReview_index.
    dbRead
      .selectFrom('Image')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('needsReview', '=', 'appeal')
      .executeTakeFirst(),
    // Distinct images with a PENDING report (matches the main app's `reported` bucket — count per image,
    // not per report). Rides `Report_pending_id_idx`; ~270ms (the streamed promise keeps it off render).
    dbRead
      .selectFrom('Report as r')
      .innerJoin('ImageReport as ir', 'ir.reportId', 'r.id')
      .select((eb) => eb.fn.count('ir.imageId').distinct().as('count'))
      .where('r.status', '=', 'Pending')
      .executeTakeFirst(),
  ]);
  return {
    ...modes,
    imageTags: Number(imageTags?.count ?? 0),
    appeals: Number(appeals?.count ?? 0),
    reported: Number(reported?.count ?? 0),
  };
}
