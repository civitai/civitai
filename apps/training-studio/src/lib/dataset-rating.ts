import type { ImageScanningInput } from '@civitai/orchestration-client';

/** The rater the imageScanning recipe runs when asked for a v2 rating. */
export const RATER_MODEL = 'radio-alpha';

/** The recipe body. `rater-model` is not in @civitai/orchestration-client 0.2.0's types yet. */
export type RatingV2ScanInput = ImageScanningInput & { 'rater-model': typeof RATER_MODEL };

/** One image's v2 rating, as the shared cache keeps it: the sexual level (0-4) and the routing flag.
 *  Stored raw, so a change of the mature setting needs no re-rating. */
export interface StoredRating {
  s: number;
  r: boolean;
}

/** What the server hands train-core when the v2 rating is on for this user. */
export interface DatasetRating {
  /** The lowest sexual level that counts an image as mature. From private flag state, never the repo. */
  matureLevel: number;
  /** Stored ratings for these blob keys; an id absent from the map is unrated. Resolves to an empty map
   *  rather than rejecting when the cache can't be read. */
  read(blobKeys: string[]): Promise<Map<string, StoredRating>>;
}

const LEVEL = /^s([0-4])$/i;
// The lowest level is not a setting: it would count every image as mature.
const SETTING = /^s([1-4])$/i;

/** The mature setting a flag variant key names, or null for anything else (unset, unknown, malformed),
 *  which callers treat as the v2 rating being off. */
export function parseMatureLevel(variantKey: string | null | undefined): number | null {
  const match = typeof variantKey === 'string' ? SETTING.exec(variantKey.trim()) : null;
  return match ? Number(match[1]) : null;
}

/** The v2 rating in an imageScanning output, or null when there is none to trust: no `ratingV2` block,
 *  a status other than "ok", or a sexual label or restricted flag that doesn't parse. The top-level
 *  `nsfwLevel` is not a v2 rating and is never read. */
export function parseRatingV2(output: unknown): StoredRating | null {
  const block = (output as { ratingV2?: unknown } | null | undefined)?.ratingV2 as
    | { status?: unknown; sexual?: { label?: unknown }; restricted?: unknown }
    | null
    | undefined;
  if (!block || typeof block !== 'object') return null;
  if (block.status !== 'ok') return null;
  const label = block.sexual?.label;
  const match = typeof label === 'string' ? LEVEL.exec(label) : null;
  if (!match || typeof block.restricted !== 'boolean') return null;
  return { s: Number(match[1]), r: block.restricted };
}

/** A cached value is trusted only in the exact shape `parseRatingV2` produces. */
export function isStoredRating(value: unknown): value is StoredRating {
  const v = value as StoredRating | null;
  return (
    !!v &&
    typeof v === 'object' &&
    Number.isInteger(v.s) &&
    v.s >= 0 &&
    v.s <= 4 &&
    typeof v.r === 'boolean'
  );
}

export function isMatureRating(rating: StoredRating, matureLevel: number): boolean {
  return rating.r || rating.s >= matureLevel;
}

/** The server's maturity count for a dataset under the v2 rating, for Review. `unrated` images were
 *  counted from their upload rating, as before. */
export type DatasetRatingCount =
  | { enabled: false }
  | { enabled: true; matureCount: number; unrated: number };
