import { z } from 'zod';

const MAX_INT4 = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT4);

/** Where a held model's flagged version text sits: a version's name, or one of its trigger words. */
export type VersionTextHit =
  | { versionId: number; field: 'name' }
  | {
      versionId: number;
      field: 'trainedWords';
      index: number;
    };

const hitSchema = z.union([
  z.object({ versionId: id, field: z.literal('name') }).strict(),
  z
    .object({ versionId: id, field: z.literal('trainedWords'), index: z.number().int().min(0) })
    .strict(),
]);

export type VersionTextHitText = VersionTextHit & {
  /** The version's current value, which may have changed since the hold; null once it is gone. */
  text: string | null;
  /** Whether the held text still carries it; false means it was edited after the hold. */
  inHeldText: boolean;
};

/** The most positions one hold lists; a meta value past it is not a list the main app wrote. */
export const VERSION_TEXT_HITS_MAX = 50;

/** The hits a Model hold's meta names; malformed entries are dropped, and none at all is null. */
export function parseVersionTextHits(value: unknown): VersionTextHit[] | null {
  if (!Array.isArray(value) || value.length > VERSION_TEXT_HITS_MAX) return null;
  const hits = value.flatMap((entry) => {
    const parsed = hitSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return hits.length ? hits : null;
}

/**
 * Whether the held text still carries this string. The held text joins each field trimmed, so the
 * string is compared trimmed too.
 */
export function heldTextIncludes(heldText: string, text: string) {
  const needle = text.replaceAll('\u0000', '').trim();
  return needle.length > 0 && heldText.includes(needle);
}
