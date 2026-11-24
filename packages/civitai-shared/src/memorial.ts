/** The `User.flags` bit a confirmed memorialization sets (the main app's `UserFlag.Memorialized`). */
export const MEMORIALIZED_USER_FLAG = 4;

export function isMemorializedFlags(flags: number | null | undefined): boolean {
  return ((flags ?? 0) & MEMORIALIZED_USER_FLAG) !== 0;
}

/** How the holder's death was confirmed before a moderator proposed memorializing the account. */
export const MEMORIAL_BASES = ['family', 'obituary', 'attestation'] as const;
export type MemorialBasis = (typeof MEMORIAL_BASES)[number];

export const MEMORIAL_BASIS_LABELS: Record<MemorialBasis, string> = {
  family: 'Family or a close contact told us',
  obituary: 'Public obituary, news item or family post',
  attestation: 'Moderator attestation from first-hand knowledge',
};

export type MemorialTribute = { label: string; url: string };

export const MEMORIAL_TRIBUTES_MAX = 3;

/**
 * `User.meta.memorial`, written only by the main app's memorial service; `status: 'active'` is set in
 * the same statement as the `Memorialized` flag. Private to `user.memorialize` holders.
 */
export type MemorialState = {
  status: 'pending' | 'active';
  basis: MemorialBasis;
  tributes: MemorialTribute[];
  proposedBy: number;
  proposedAt: string;
  confirmedBy?: number;
  confirmedAt?: string;
  /** Whether confirming set `ExcludeFromEventPoints`, so reversing clears only what it set. */
  setEventExclusion?: boolean;
};

/** `meta` without the memorial record, for a payload that is not limited to `user.memorialize` holders. */
export function withoutMemorial<T>(meta: T): T {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !('memorial' in meta))
    return meta;
  const { memorial: _memorial, ...rest } = meta as Record<string, unknown>;
  return rest as T;
}

export function memorialOf(meta: unknown): MemorialState | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const memorial = (meta as { memorial?: unknown }).memorial;
  return memorial && typeof memorial === 'object' ? (memorial as MemorialState) : null;
}
