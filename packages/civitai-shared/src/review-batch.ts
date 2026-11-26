import { createHash, randomBytes } from 'node:crypto';
import type { BlockedForPatterns, ScannerVerdict } from './media-signals';
import { retractedViewable, type RetractedAccessRow } from './retracted-media-tier';

/**
 * A review batch: a set of site image ids an agent hands a moderator for the phone review sheet. The
 * main app mints one into sys Redis; the moderator app signs the sheet in to it and serves it. Server
 * only.
 */

export type ReviewTier = 'general' | 'held';
export const REVIEW_TIERS: readonly ReviewTier[] = ['general', 'held'];

export const REVIEW_BATCH_MAX_IDS = 50;

/** The ModActivity `activity` for general-tier bytes served from byte 0. */
export const REVIEW_SERVED_ACTIVITY = 'review-media-served';
export const REVIEW_BATCH_TTL_SECONDS = 24 * 60 * 60;

export type ReviewBatchRecord = {
  ids: number[];
  tier: ReviewTier;
  /** The batch was declared suspect by its minter, or has no source card. */
  declared: boolean;
  viewer: number;
  createdBy: number;
  /** The minting API key, so revoking the key can find every batch it minted. */
  keyId: number;
  seat: string | null;
  createdAt: number;
};

/** 16 random bytes, 22 base64url characters. */
export const newReviewBatchId = () => randomBytes(16).toString('base64url');
const BATCH_ID = /^[A-Za-z0-9_-]{22}$/;
export const isReviewBatchId = (value: string) => BATCH_ID.test(value);

/** What Redis stores in place of the id, which is the link's only secret. */
export const reviewBatchHash = (batchId: string) =>
  createHash('sha256').update(batchId).digest('base64url');

export const REVIEW_MEDIA_ORIGIN = 'https://moderator.civitai.com';
export const reviewBatchLink = (tier: ReviewTier, batchId: string, origin = REVIEW_MEDIA_ORIGIN) =>
  `${origin}/api/${tier === 'held' ? 'held' : 'review'}-media/b/${batchId}`;

export function parseReviewBatchRecord(raw: string | null | undefined): ReviewBatchRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ReviewBatchRecord>;
    const ids = value.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > REVIEW_BATCH_MAX_IDS ||
      !ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
      !REVIEW_TIERS.includes(value.tier as ReviewTier) ||
      typeof value.declared !== 'boolean' ||
      !Number.isSafeInteger(value.viewer) ||
      !Number.isSafeInteger(value.createdBy) ||
      !Number.isSafeInteger(value.keyId) ||
      typeof value.createdAt !== 'number'
    )
      return null;
    return value as ReviewBatchRecord;
  } catch {
    return null;
  }
}

/** One image's Postgres signals: `retractedAccessColumnsSql`, `unreadableImageSql`, `heldImageSql`
 *  as `held`, and its raw blockedFor. */
export type ImageSignalRow = RetractedAccessRow & {
  id: number;
  unreadable: boolean;
  held: boolean;
};

/**
 * Whether an image must go to the held tier, by the rule the retracted-media routes apply to a
 * moderator without the CSAM grant (`retractedViewable`): a minor flag, label or removal alone stays
 * general; a `blockedFor` value `blockedForSignal` reads as a signal does not. An id with no row, or
 * an unfinished scan, cannot be read, so it is held. Held media (`held`) stays on the held tier.
 */
export async function imageRoutesHeld(
  row: ImageSignalRow | undefined,
  {
    patterns,
    verdict,
    readVerdicts,
  }: {
    patterns: BlockedForPatterns | null;
    verdict: ScannerVerdict | null;
    readVerdicts: (imageIds: number[]) => Promise<Map<number, ScannerVerdict> | null>;
  }
): Promise<boolean> {
  if (!row || row.unreadable || row.held) return true;
  const viewable = await retractedViewable(row, {
    patterns,
    readVerdict: async () => verdict,
    readVerdicts,
  });
  return !viewable;
}
