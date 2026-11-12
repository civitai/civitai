/**
 * The developer track-record line beside the creator card on a listing page (pure, React-free,
 * so the node `unit` project covers it).
 *
 * "4 apps · 12 reviews": the developer's listings this viewer could find in the store and the
 * counted reviews on them (`appListings.getDeveloperTrackRecord`, which reads under the store
 * predicate). A listing marked Official is made by the Civitai team, so it shows the Official
 * badge in this place instead of a count.
 */

import type { DeveloperTrackRecord } from '~/server/schema/blocks/app-listing-read.schema';

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function formatDeveloperTrackRecord(record: DeveloperTrackRecord): string {
  return `${plural(record.appCount, 'app', 'apps')} · ${plural(
    record.reviewCount,
    'review',
    'reviews'
  )}`;
}

export type DeveloperTrackRecordView = { kind: 'official' } | { kind: 'record'; text: string };

/**
 * What renders beside the creator card: the Official badge on an Official listing, otherwise
 * the record — or nothing while the record is unknown or counts no visible app.
 */
export function developerTrackRecordView(opts: {
  isOfficial: boolean;
  record: DeveloperTrackRecord | null | undefined;
}): DeveloperTrackRecordView | null {
  if (opts.isOfficial) return { kind: 'official' };
  if (!opts.record || opts.record.appCount <= 0) return null;
  return { kind: 'record', text: formatDeveloperTrackRecord(opts.record) };
}
