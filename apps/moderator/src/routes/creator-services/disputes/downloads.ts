import { utcMs } from '$lib/format';
import type { DealFile, DisputeRow } from '$lib/server/creator-services-disputes.service';

export type BuyerFinalDownloads =
  | { state: 'unknown'; reason: 'not-reported' | 'before-recording' }
  | { state: 'never' }
  | {
      state: 'yes';
      count: number;
      firstAt: string;
      lastAt: string;
      /** Null when that cannot be told: no dispute time, or the first download may predate recording. */
      beforeDispute: boolean | null;
      /** The deal completed before recording began, so earlier downloads are missing. */
      partial: boolean;
    };

/**
 * The buyer's own takes of the deal's finals, through the site or (as a moderator) the dispute tool.
 * Null for a deal with no finals. No rows proves nothing for a deal completed before the first
 * recorded access: those downloads were never recorded.
 */
export function buyerFinalDownloads(
  files: DealFile[],
  deal: Pick<DisputeRow, 'disputeOpenedAt' | 'completedAt'>,
  recordedSince: string | null
): BuyerFinalDownloads | null {
  const finals = files.filter((file) => file.kind === 'Final');
  if (!finals.length) return null;
  if (finals.some((file) => !file.access)) return { state: 'unknown', reason: 'not-reported' };

  const partial =
    !!deal.completedAt && (!recordedSince || utcMs(deal.completedAt) < utcMs(recordedSince));
  // A moderator fetch never counts, even by a moderator who is the buyer.
  const entries = finals
    .flatMap((file) => file.access ?? [])
    .filter((e) => e.role === 'Buyer' && e.kind === 'Download');
  if (!entries.length)
    return partial ? { state: 'unknown', reason: 'before-recording' } : { state: 'never' };

  const firsts = entries.map((e) => utcMs(e.firstAt));
  const lasts = entries.map((e) => utcMs(e.lastAt));
  const firstAt = entries[firsts.indexOf(Math.min(...firsts))].firstAt;
  const before = deal.disputeOpenedAt ? Math.min(...firsts) < utcMs(deal.disputeOpenedAt) : null;
  return {
    state: 'yes',
    count: entries.reduce((sum, e) => sum + e.count, 0),
    firstAt,
    lastAt: entries[lasts.indexOf(Math.max(...lasts))].lastAt,
    beforeDispute: before === false && partial ? null : before,
    partial,
  };
}
