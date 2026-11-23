import { isLevelShownOnDomain } from '~/server/common/image-visibility';
import { parseStoredCandidate } from '~/shared/utils/comic-candidates';

export type CandidateEntry =
  | { key: string; nsfwLevel?: number; outputId?: string }
  | {
      requiresUnlock: true;
      blockedReason: string;
      nsfwLevel?: number;
      outputId?: string;
      key?: string;
    };

export type CandidateOutput = {
  id?: string | null;
  url?: string | null;
  blockedReason?: string | null;
};

/** The stricter of two levels; a rating never lowers one already stored. */
export function stricterLevel(stored: number | null | undefined, fresh: number | null | undefined) {
  if (stored == null) return fresh ?? undefined;
  if (fresh == null) return stored;
  return Math.max(stored, fresh);
}

export type CandidateSlotPlan =
  | { kind: 'locked'; entry: CandidateEntry }
  | { kind: 'reuse'; entry: CandidateEntry }
  | { kind: 'missing' | 'download'; outputId?: string; nsfwLevel?: number };

/**
 * What to store for each output of a multi-image generation, given what is stored now. An output
 * carrying a block is locked before any stored key is looked at. A stored key is reused only from
 * the entry with the same output id; entries written before ids were stored match by position, and
 * only when the batch has the same length and no blocked output, else they are locked. A locked
 * entry keeps a key only when it was matched by id; it is never handed out while locked.
 */
export function planCandidateSlots(
  outputs: (CandidateOutput | null | undefined)[],
  storedValue: unknown,
  freshLevels: (number | null | undefined)[]
): CandidateSlotPlan[] {
  const stored = Array.isArray(storedValue) ? storedValue.map(parseStoredCandidate) : [];
  const positionMatchSafe =
    stored.length === outputs.length && !outputs.some((out) => out?.blockedReason);

  return outputs.map((out, i) => {
    const outputId = typeof out?.id === 'string' && out.id ? out.id : undefined;
    const byId = outputId ? stored.find((entry) => entry?.outputId === outputId) : undefined;
    const legacy = !byId && stored[i] && !stored[i]?.outputId ? stored[i] : undefined;
    const previous = byId ?? legacy ?? null;
    const nsfwLevel = stricterLevel(previous?.nsfwLevel, freshLevels[i]);
    const level = nsfwLevel != null ? { nsfwLevel } : {};
    const id = outputId ? { outputId } : {};
    // Only a key matched by id is known to be this output's, so only it stays beside a lock. A key
    // matched by position is retained (see retainedCandidateKeys) instead, never bound to this id.
    const keptKey = byId?.key ? { key: byId.key } : {};

    if (out?.blockedReason) {
      return {
        kind: 'locked',
        entry: {
          requiresUnlock: true,
          blockedReason: out.blockedReason,
          ...level,
          ...id,
          ...keptKey,
        },
      };
    }
    if (legacy?.key && !legacy.locked && !positionMatchSafe) {
      return {
        kind: 'locked',
        entry: { requiresUnlock: true, blockedReason: 'canUpgrade', ...level, ...id, ...keptKey },
      };
    }
    if (!out?.url) return { kind: 'missing', outputId, nsfwLevel };
    // A locked entry matched by id holds this same output's key, so it comes back when the block lifts.
    if (previous?.key && (!previous.locked || byId)) {
      return { kind: 'reuse', entry: { key: previous.key, ...level, ...id } };
    }
    return { kind: 'download', outputId, nsfwLevel };
  });
}

/** Whether a response may hand this entry's key to the owner: unlocked, and on green a safe level. */
const isKeyOffered = (
  entry: CandidateEntry,
  isGreen: boolean
): entry is Extract<CandidateEntry, { key: string }> =>
  !('requiresUnlock' in entry) && isLevelShownOnDomain(entry.nsfwLevel, isGreen);

/** A candidate as a poll or unlock response returns it: a locked or withheld one carries no key. */
export function respondedCandidate(
  entry: CandidateEntry,
  blurredPreviewUrl: string | null,
  isGreen: boolean
) {
  if (isKeyOffered(entry, isGreen)) return { key: entry.key, nsfwLevel: entry.nsfwLevel ?? null };
  return {
    requiresUnlock: true as const,
    blockedReason: 'requiresUnlock' in entry ? entry.blockedReason : 'siteRestricted',
    blurredPreviewUrl: 'requiresUnlock' in entry ? blurredPreviewUrl : null,
    nsfwLevel: entry.nsfwLevel ?? null,
  };
}

/** The keys a response may offer for selection. */
export const selectableKeys = (entries: CandidateEntry[], isGreen: boolean) =>
  entries.flatMap((entry) => (isKeyOffered(entry, isGreen) ? [entry.key] : []));

/**
 * Stored keys the new candidate set no longer holds, added to those already retained. Nothing reads
 * them back; they keep a replaced generation output from being lost.
 */
export function retainedCandidateKeys(
  storedValue: unknown,
  next: CandidateEntry[],
  alreadyRetained: unknown
): string[] {
  const kept = new Set(next.flatMap((entry) => (entry.key ? [entry.key] : [])));
  const stored = Array.isArray(storedValue) ? storedValue : [];
  const previous = Array.isArray(alreadyRetained)
    ? alreadyRetained.filter((key): key is string => typeof key === 'string')
    : [];
  const dropped = stored
    .map((entry) => parseStoredCandidate(entry)?.key)
    .filter((key): key is string => !!key && !kept.has(key));
  return [...new Set([...previous, ...dropped])];
}
