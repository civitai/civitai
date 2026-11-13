import { z } from 'zod';

// Not `int4Id` from `$lib/server/query`: that module pulls in the database, and this one is read by
// client components; it also coerces, which would accept a string id the main app never writes.
const MAX_INT4 = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INT4);

/** Where a held model's flagged version text sits: a version's name, or one of its trigger words. */
export type VersionTextHit =
  | { versionId: number; field: 'name' }
  | { versionId: number; field: 'trainedWords'; index: number };

/**
 * How the current value compares with what was flagged. `unchanged` / `edited` come from the check
 * value the hold stored; holds written before it only say whether the held text has the value.
 */
export type VersionTextHitState =
  | 'unchanged'
  | 'edited'
  | 'gone'
  | 'in-held-text'
  | 'not-in-held-text';

export type VersionTextHitText = VersionTextHit & {
  /** The version's current value; null once it is gone. */
  text: string | null;
  state: VersionTextHitState;
};

/** A position as stored, with its check value. The check value never leaves the server. */
export type StoredVersionTextHit = VersionTextHit & { hash?: string };

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const hitSchema = z.union([
  z.object({ versionId: id, field: z.literal('name'), hash: hash.optional() }).strict(),
  z
    .object({
      versionId: id,
      field: z.literal('trainedWords'),
      index: z.number().int().min(0),
      hash: hash.optional(),
    })
    .strict(),
]);

/** The most positions one hold lists; a meta value past it is not a list the main app wrote. */
export const VERSION_TEXT_HITS_MAX = 50;

export const versionTextHitKey = (hit: VersionTextHit) =>
  `${hit.versionId}:${hit.field}:${hit.field === 'trainedWords' ? hit.index : ''}`;

/** The hits a Model hold's meta names, each once; malformed entries are dropped, and none at all is null. */
export function parseVersionTextHits(value: unknown): StoredVersionTextHit[] | null {
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

/**
 * A Model hold's positions, unless they describe held text a later scan has since replaced
 * (`comVersionTextHoldHash` no longer the hold's `textHash`). Holds written before that value have
 * no such check.
 */
export function holdVersionTextHits(meta: unknown, textHash: string) {
  const { comVersionTextHits, comVersionTextHoldHash } = (meta ?? {}) as Record<string, unknown>;
  const hits = parseVersionTextHits(comVersionTextHits);
  const stale =
    !!hits && typeof comVersionTextHoldHash === 'string' && comVersionTextHoldHash !== textHash;
  return { hits: stale ? null : hits, stale };
}

/** A position without its check value, for anything sent to the browser. */
export const publicVersionTextHit = (hit: StoredVersionTextHit): VersionTextHit =>
  hit.field === 'name'
    ? { versionId: hit.versionId, field: 'name' }
    : { versionId: hit.versionId, field: 'trainedWords', index: hit.index };

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
