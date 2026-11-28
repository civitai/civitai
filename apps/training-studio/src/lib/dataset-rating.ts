/** The rater the imageScanning recipe runs when asked for a v2 rating. */
export const RATER_MODEL = 'radio-alpha';

/** One image's v2 rating, as the shared cache keeps it: the main app's mature bit at one mature level,
 *  so the cache is keyed by that level. */
export interface StoredRating {
  mature: boolean;
}

/** What the server hands train-core when the v2 rating is on for this user. */
export interface DatasetRating {
  /** The lowest sexual level that counts an image as mature. From private flag state, never the repo. */
  matureLevel: number;
  /** Stored ratings for these blob keys; an id absent from the map is unrated. Resolves to an empty map
   *  rather than rejecting when the cache can't be read. */
  read(blobKeys: string[]): Promise<Map<string, StoredRating>>;
}

// The lowest level is not a setting: it would count every image as mature.
const SETTING = /^s([1-4])$/i;

/** The mature setting a flag variant key names, or null for anything else (unset, unknown, malformed),
 *  which callers treat as the v2 rating being off. */
export function parseMatureLevel(variantKey: string | null | undefined): number | null {
  const match = typeof variantKey === 'string' ? SETTING.exec(variantKey.trim()) : null;
  return match ? Number(match[1]) : null;
}

export function isStoredRating(value: unknown): value is StoredRating {
  return (
    !!value && typeof value === 'object' && typeof (value as StoredRating).mature === 'boolean'
  );
}

/** The server's maturity count for a dataset under the v2 rating, for Review, and each rated image's
 *  verdict, for its tile. `unrated` images were counted from their upload rating, as before. A null
 *  `matureCount` is a count Review should not use: it keeps its own. */
export type DatasetRatingCount =
  | { enabled: false }
  | {
      enabled: true;
      matureCount: number | null;
      unrated: number;
      /** Mature or not by blob id: the v2 verdict alone, never a level or why. */
      verdicts: Record<string, boolean>;
    };
