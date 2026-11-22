/**
 * One entry of a comic panel's stored `candidateImages`. Older rows hold a bare key string; newer
 * ones an object. A locked entry may keep the key it had before it was locked, which no reader
 * hands out.
 */
export type StoredCandidate = {
  key: string | null;
  locked: boolean;
  blockedReason: string | null;
  nsfwLevel: number | null;
  outputId: string | null;
};

export function parseStoredCandidate(entry: unknown): StoredCandidate | null {
  if (typeof entry === 'string') {
    return entry
      ? { key: entry, locked: false, blockedReason: null, nsfwLevel: null, outputId: null }
      : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { key, requiresUnlock, blockedReason, nsfwLevel, outputId } = entry as Record<
    string,
    unknown
  >;
  const locked = !!requiresUnlock;
  const storedKey = typeof key === 'string' && key ? key : null;
  if (!locked && !storedKey) return null;
  return {
    key: storedKey,
    locked,
    blockedReason: locked
      ? typeof blockedReason === 'string'
        ? blockedReason
        : 'canUpgrade'
      : null,
    nsfwLevel: typeof nsfwLevel === 'number' ? nsfwLevel : null,
    outputId: typeof outputId === 'string' && outputId ? outputId : null,
  };
}

export function parseStoredCandidates(value: unknown): StoredCandidate[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map(parseStoredCandidate)
    .filter((entry): entry is StoredCandidate => entry !== null);
}
