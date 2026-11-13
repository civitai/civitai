import { z } from 'zod';

// Not `int4Id` from `$lib/server/query`: that module pulls in the database, and this one is read by
// client components; it also coerces, which would accept a string id the main app never writes.
const MAX_INT4 = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT4);

/** Where a held model's flagged version text sits: a version's name, or one of its trigger words. */
export type VersionTextHit =
  | { versionId: number; field: 'name' }
  | { versionId: number; field: 'trainedWords'; index: number };

export type VersionTextHitText = VersionTextHit & {
  /** The version's current value, which may have changed since the hold; null once it is gone. */
  text: string | null;
  /** Whether the held text still carries it in that field; false means it was edited after the hold. */
  inHeldText: boolean;
};

const hitSchema = z.union([
  z.object({ versionId: id, field: z.literal('name') }).strict(),
  z
    .object({ versionId: id, field: z.literal('trainedWords'), index: z.number().int().min(0) })
    .strict(),
]);

/** The most positions one hold lists; a meta value past it is not a list the main app wrote. */
export const VERSION_TEXT_HITS_MAX = 50;

export const versionTextHitKey = (hit: VersionTextHit) =>
  `${hit.versionId}:${hit.field}:${hit.field === 'trainedWords' ? hit.index : ''}`;

/** The hits a Model hold's meta names, each once; malformed entries are dropped, and none at all is null. */
export function parseVersionTextHits(value: unknown): VersionTextHit[] | null {
  if (!Array.isArray(value) || value.length > VERSION_TEXT_HITS_MAX) return null;
  const seen = new Set<string>();
  const hits = value.flatMap((entry) => {
    const parsed = hitSchema.safeParse(entry);
    if (!parsed.success || seen.has(versionTextHitKey(parsed.data))) return [];
    seen.add(versionTextHitKey(parsed.data));
    return [parsed.data];
  });
  return hits.length ? hits : null;
}

const HEADINGS: Record<VersionTextHit['field'], string> = {
  name: 'Version name',
  trainedWords: 'Trained words',
};

/** The bodies of every `## <heading>` field; the held text joins `## Heading\nbody` fields with a blank line. */
function fieldBodies(heldText: string, heading: string) {
  const marker = `## ${heading}\n`;
  return `\n\n${heldText}`
    .split('\n\n## ')
    .map((part) => `## ${part}`)
    .filter((block) => block.startsWith(marker))
    .map((block) => block.slice(marker.length));
}

/**
 * Whether the held text still carries this string as a whole value of that field: a version name,
 * or one word of a trigger-word list. Fields are stored trimmed and words joined with ", ".
 */
export function heldTextHas(heldText: string, field: VersionTextHit['field'], text: string) {
  const needle = text.replaceAll('\u0000', '').trim();
  if (!needle) return false;
  const bodies = fieldBodies(heldText, HEADINGS[field]);
  if (field === 'name') return bodies.some((body) => body === needle);
  return bodies.some((body) => body.split(', ').some((word) => word.trim() === needle));
}
