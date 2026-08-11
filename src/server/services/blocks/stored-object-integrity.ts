import type { StoredImageHead } from '~/server/utils/stored-image-probe';

/**
 * The measurement a persist proc takes of an uploaded object describes the bytes
 * that were there AT PROBE TIME — the upload grant outlives the probe, so the
 * object at that key can differ later while the row still describes the old bytes
 * (see the header of `~/server/utils/stored-image-probe`). Every consumer that
 * makes a DECISION from those persisted columns is therefore trusting a claim
 * about a moment that has passed.
 *
 * This module is the pure half of closing that gap: the persist procs record the
 * store's entity tag next to the measurement, and a consumer re-reads the tag and
 * compares. No db, no network, no `sharp` — so the RULE that decides whether an
 * attach may proceed is unit-testable on its own, and lives in exactly one place
 * rather than being re-derived at each of the three attach procs.
 */

/**
 * Key under `Image.metadata` holding the entity tag of the object the row's
 * dimensions / MIME / byte size were measured from.
 *
 * 🔴 Additive and OPTIONAL by construction. Rows written before this existed, and
 * rows created by paths that never measure an uploaded object, simply do not carry
 * it — {@link classifyStoredObjectIntegrity} reports those `unverifiable`, never
 * `mismatch`. Absence is the absence of EVIDENCE, and must never be read as
 * evidence of tampering.
 */
export const STORED_OBJECT_ETAG_META_KEY = 'storedEtag' as const;

/**
 * Why a comparison could not be made. Kept distinct rather than collapsed into one
 * `unverifiable`, because they are operationally different signals: a store that
 * cannot be reached is an infrastructure event, while a row with no recorded tag is
 * just an older row.
 */
export type StoredObjectIntegrityUnverifiableReason =
  /** The row carries no recorded tag — created before this existed, or by a path that does not measure. */
  | 'no-recorded-etag'
  /** The store answered that the key is gone. Nothing to compare against. */
  | 'object-absent'
  /** The store could not be consulted at all. */
  | 'store-unreachable'
  /** The object is there, but the store returned no tag for it. */
  | 'no-current-etag';

export type StoredObjectIntegrity =
  | { status: 'match' }
  | { status: 'mismatch' }
  | { status: 'unverifiable'; reason: StoredObjectIntegrityUnverifiableReason };

/**
 * Entity tags are quoted by the S3 wire format (`"d41d8…"`), and a backend may or
 * may not preserve the quoting across a `GetObject` vs a `HeadObject`. Compare the
 * token, not its punctuation: strip surrounding whitespace and at most one layer of
 * double quotes.
 *
 * Returns `null` for anything that is not a non-empty token afterwards, so an empty
 * or whitespace-only tag can never compare equal to another empty one and be read
 * as agreement.
 */
export function normalizeEtag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  // Weak-validator prefix (`W/"…"`) — a byte-for-byte comparison is what we want,
  // so a weak tag is deliberately NOT accepted as a strong one.
  if (value.startsWith('W/')) return null;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : null;
}

/**
 * Read the recorded entity tag out of an `Image.metadata` blob. `metadata` is an
 * untyped JSON column, so every shape that is not a usable tag — `null`, a number,
 * an object, an empty string — returns `null` ("nothing recorded").
 */
export function readRecordedEtag(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  return normalizeEtag((metadata as Record<string, unknown>)[STORED_OBJECT_ETAG_META_KEY]);
}

/**
 * The `Image.metadata` fragment a persist proc merges in to record the tag it
 * measured from. An unusable tag contributes NOTHING rather than a `null` entry, so
 * "no evidence" has one representation on the read side.
 *
 * Shared by every persist path rather than open-coded at each, so the key and the
 * omit-when-absent rule cannot drift between them.
 */
export function storedObjectEtagMetadata(
  etag: string | null
): Record<string, string> | Record<string, never> {
  const normalized = normalizeEtag(etag);
  return normalized === null ? {} : { [STORED_OBJECT_ETAG_META_KEY]: normalized };
}

/**
 * Compare a recorded tag against a fresh head of the same key.
 *
 * 🔴 `mismatch` is the ONLY verdict that asserts anything. It requires two tags
 * that both exist and disagree — i.e. the store is holding an object that is
 * demonstrably not the one that was measured. Every other combination is
 * `unverifiable`: a missing tag on either side, an absent object, an unreachable
 * store. A consumer must fail CLOSED on `mismatch` and must NOT fail closed on
 * `unverifiable`, or an unrelated store hiccup becomes a user-facing rejection —
 * the same posture `headObject`'s three-state result documents in `~/utils/s3-utils`.
 */
export function classifyStoredObjectIntegrity(
  recordedEtag: string | null,
  head: StoredImageHead
): StoredObjectIntegrity {
  const recorded = normalizeEtag(recordedEtag);
  if (recorded === null) return { status: 'unverifiable', reason: 'no-recorded-etag' };
  if (head.status === 'absent') return { status: 'unverifiable', reason: 'object-absent' };
  if (head.status === 'unknown') return { status: 'unverifiable', reason: 'store-unreachable' };
  const current = normalizeEtag(head.etag);
  if (current === null) return { status: 'unverifiable', reason: 'no-current-etag' };
  return current === recorded ? { status: 'match' } : { status: 'mismatch' };
}
