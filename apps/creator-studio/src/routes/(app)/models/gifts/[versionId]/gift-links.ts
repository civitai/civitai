/** A row of GET /api/v1/model-versions/[id]/gifts. Dates arrive as ISO strings. */
export type GiftLinkRow = {
  id: number;
  codeHint: string;
  label: string | null;
  batchId: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type GiftGroup =
  | { kind: 'link'; link: GiftLinkRow }
  | {
      kind: 'batch';
      batchId: string;
      label: string | null;
      total: number;
      redeemed: number;
      revoked: number;
      createdAt: string;
      expiresAt: string | null;
    };

/** Bulk codes collapse to one row per batch; the creator manages a batch, not 500 codes. */
export function groupGiftLinks(items: GiftLinkRow[]): GiftGroup[] {
  const groups: GiftGroup[] = [];
  const batches = new Map<string, Extract<GiftGroup, { kind: 'batch' }>>();
  for (const item of items) {
    if (!item.batchId) {
      groups.push({ kind: 'link', link: item });
      continue;
    }
    let batch = batches.get(item.batchId);
    if (!batch) {
      batch = {
        kind: 'batch',
        batchId: item.batchId,
        label: item.label,
        total: 0,
        redeemed: 0,
        revoked: 0,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
      };
      batches.set(item.batchId, batch);
      groups.push(batch);
    }
    batch.total++;
    if (item.redemptionCount > 0) batch.redeemed++;
    if (item.revokedAt) batch.revoked++;
  }
  return groups;
}

export function codesCsv(codes: string[]) {
  return 'code\n' + codes.join('\n') + '\n';
}
