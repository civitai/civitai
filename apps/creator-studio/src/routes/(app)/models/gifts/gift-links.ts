/** GET /api/v1/model-versions/[id]/gifts. Dates arrive as ISO strings. */
export type GiftList = { links: GiftLinkRow[]; batches: GiftBatchRow[] };

export type GiftLinkRow = {
  id: number;
  codeHint: string;
  label: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type GiftBatchRow = {
  batchId: string;
  label: string | null;
  total: number;
  claimed: number;
  /** Codes still claimable: not revoked, not claimed, not expired. */
  live: number;
  createdAt: string;
  expiresAt: string | null;
};

type GiftIndexVersion = {
  modelVersionId: number;
  versionName: string;
  modelId: number;
  modelName: string;
};

/** GET /api/v1/model-versions/gifts: the creator's links and batches across their versions. */
export type GiftIndexPage = {
  items: (
    | ({ kind: 'link' } & GiftLinkRow & GiftIndexVersion)
    | ({ kind: 'batch' } & GiftBatchRow & GiftIndexVersion)
  )[];
  nextCursor: string | null;
};

/** GET .../gifts/[giftId]/claims and .../gifts/batch/[batchId]/claims. */
export type GiftClaimsPage = {
  claims: {
    giftLinkId: number;
    userId: number;
    username: string | null;
    claimedAt: string;
    /** When the claimer's gifted access was removed; null while it stands. */
    revokedAt: string | null;
  }[];
  nextCursor: string | null;
  /** Claims from before claimers were told the creator can see them: counted, never named. Sent on the first page only; null after it. */
  hiddenCount: number | null;
};

export type GiftStatus = 'Active' | 'Claimed' | 'Expired' | 'Revoked';

const isPast = (d: string | null, now: Date) => !!d && new Date(d) <= now;

export function linkStatus(link: GiftLinkRow, now = new Date()): GiftStatus {
  if (link.revokedAt) return 'Revoked';
  if (isPast(link.expiresAt, now)) return 'Expired';
  if (link.maxRedemptions != null && link.redemptionCount >= link.maxRedemptions) return 'Claimed';
  return 'Active';
}

export function batchStatus(batch: GiftBatchRow, now = new Date()): GiftStatus {
  if (batch.live > 0) return 'Active';
  if (batch.claimed === batch.total) return 'Claimed';
  if (isPast(batch.expiresAt, now)) return 'Expired';
  return 'Revoked';
}

/** One claim link per line, so a recipient never has to build the URL. */
export function codesCsv(codes: string[], giftBase: string) {
  return 'code,link\n' + codes.map((code) => `${code},${giftBase}${code}`).join('\n') + '\n';
}

/** The end of the picked day in the creator's own zone, as ISO; empty stays empty. */
export function endOfLocalDay(date: string) {
  return date ? new Date(`${date}T23:59:59.999`).toISOString() : '';
}
