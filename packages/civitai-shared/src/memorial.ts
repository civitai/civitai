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
 * `User.meta.memorial`, written only by the main app's memorial service. `status: 'active'` is set in
 * the same statement as the `Memorialized` user flag. Never send it to the account's owner or visitors.
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

export function memorialOf(meta: unknown): MemorialState | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const memorial = (meta as { memorial?: unknown }).memorial;
  return memorial && typeof memorial === 'object' ? (memorial as MemorialState) : null;
}
