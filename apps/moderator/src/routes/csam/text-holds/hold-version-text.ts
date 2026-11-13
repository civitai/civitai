import type { VersionTextHitText } from '$lib/csam-holds/version-text-hits';

/** `gone`: the hold no longer names any flagged version text. */
export type HoldVersionTexts = { hits: VersionTextHitText[] } | { gone: true };

// Not cached: each look reads the strings as they are now.
export async function fetchHoldVersionTexts(holdId: number): Promise<HoldVersionTexts> {
  const res = await fetch(`/api/csam-hold-version-text/${holdId}`);
  if (res.status === 404) return { gone: true };
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as { hits: VersionTextHitText[] };
}
