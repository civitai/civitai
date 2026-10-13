import { isUUID } from '~/utils/string-helpers';

/**
 * Identifier-shaped leaves in App Blocks shared storage.
 *
 * Apps fill their shared data with machine identifiers: ULIDs, UUIDs, hex digests, numeric ids, and
 * counter keys built from them (`plays:<id>`, `votes:<round>:<id>`). Such a value is not free text,
 * so the shared-data scan does not run its free-text audits (the minor detector and the green-domain
 * audit) over the identifier itself. Every other check still reads the whole leaf, and the
 * free-text audits still read the labels in front of an identifier (`sharedLeafFreeText`). This applies to the shared-data scan only; no other surface uses it.
 *
 * The predicate is deliberately strict: anything that is not WHOLLY one of the shapes below is free
 * text and is read in full.
 */

/** A ULID exactly as `newUlid()` writes it: 26 upper-case Crockford base32 chars, 48-bit time first. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** A hex digest: 128, 160 or 256 bits, either case. */
const HEX_DIGEST = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** A non-negative decimal integer, up to 20 digits. */
const DECIMAL = /^[0-9]{1,20}$/;
/** A short, app-chosen, lower-case label in front of an identifier (`plays` in `plays:<id>`). */
const LABEL = /^[a-z][a-z0-9_-]{0,31}$/;
/** Colon-separated segments in one leaf, labels and identifiers together. */
const MAX_SEGMENTS = 4;

const isIdentifier = (segment: string) =>
  // `isUUID`: a canonical 8-4-4-4-12 UUID, any version, either case.
  ULID.test(segment) || isUUID(segment) || HEX_DIGEST.test(segment) || DECIMAL.test(segment);

/**
 * The leaf split into its labels and identifiers, or `null` when it is not identifier-shaped.
 *
 * Identifier-shaped means the whole trimmed string is `label:` zero or more times, then one or more
 * identifiers joined by `:`, at most `MAX_SEGMENTS` segments in all. So `<id>`, `plays:<id>` and
 * `votes:12:<id>` qualify; `<id> and more`, `plays:<id>:extra`, `Plays:<id>` and `:<id>` do not.
 */
function identifierParts(text: string): { labels: string[]; ids: string[] } | null {
  const segments = text.trim().split(':');
  if (segments.length > MAX_SEGMENTS) return null;
  const firstId = segments.findIndex(isIdentifier);
  if (firstId === -1) return null;
  const labels = segments.slice(0, firstId);
  const ids = segments.slice(firstId);
  if (!labels.every((s) => LABEL.test(s)) || !ids.every(isIdentifier)) return null;
  return { labels, ids };
}

/** True only when the WHOLE trimmed leaf is an identifier, or a labelled identifier (see above). */
export function isIdentifierShapedLeaf(text: string): boolean {
  return identifierParts(text) !== null;
}

/**
 * The part of a leaf the free-text audits read. A leaf that is not identifier-shaped is returned
 * unchanged. An identifier-shaped one is reduced to its labels, `:`-joined: a bare identifier reads
 * as `''`, while the label of `plays:<id>` is still audited.
 */
export function sharedLeafFreeText(text: string): string {
  return identifierParts(text)?.labels.join(':') ?? text;
}
