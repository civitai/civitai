import type { DealFile, DisputeRow } from '$lib/server/creator-services-disputes.service';

export type BuyerFinalDownloads =
  | { downloaded: null }
  | { downloaded: false }
  | { downloaded: true; count: number; firstAt: string; lastAt: string; beforeDispute: boolean };

/** The buyer's own downloads of the deal's finals. A moderator fetch is a different kind and never counts. */
export function buyerFinalDownloads(
  files: DealFile[],
  disputeOpenedAt: DisputeRow['disputeOpenedAt']
): BuyerFinalDownloads {
  const finals = files.filter((file) => file.kind === 'Final');
  // A main app that does not send `access` yet must not read as "never downloaded".
  if (finals.some((file) => !file.access)) return { downloaded: null };
  const entries = finals
    .flatMap((file) => file.access ?? [])
    .filter((entry) => entry.role === 'Buyer' && entry.kind === 'Download');
  if (!entries.length) return { downloaded: false };

  const time = (at: string) => new Date(at).getTime();
  const firstAt = entries.reduce(
    (a, e) => (time(e.firstAt) < time(a) ? e.firstAt : a),
    entries[0].firstAt
  );
  const lastAt = entries.reduce(
    (a, e) => (time(e.lastAt) > time(a) ? e.lastAt : a),
    entries[0].lastAt
  );
  return {
    downloaded: true,
    count: entries.reduce((sum, e) => sum + e.count, 0),
    firstAt,
    lastAt,
    beforeDispute: !!disputeOpenedAt && time(firstAt) < time(disputeOpenedAt),
  };
}
