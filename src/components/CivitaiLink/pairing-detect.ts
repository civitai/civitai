import type { CivitaiLinkInstance } from '~/components/CivitaiLink/civitai-link-api';

export type PairingSnapshot = { ids: number[]; keys: Record<number, string> };

export function detectPairing(
  prev: PairingSnapshot,
  next: CivitaiLinkInstance[]
): CivitaiLinkInstance | null {
  const known = new Set(prev.ids);
  const added = next.find((instance) => !known.has(instance.id));
  if (added) return added;

  const rekeyed = next.find((instance) => {
    const previousKey = prev.keys[instance.id];
    return previousKey !== undefined && instance.key !== previousKey;
  });
  return rekeyed ?? null;
}
