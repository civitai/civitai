/**
 * An imported panel: no prompt, and either no metadata (createPanelFromImage) or a source with no
 * generation flags (enhancePanel without a prompt). Reads `hasSourceImage`, which the server sends
 * even when it withholds the source's url.
 */
export const isImportedPanel = (
  prompt: string | null | undefined,
  meta: { hasSourceImage?: boolean; enhanceEnabled?: boolean } | null
) => !prompt && (!meta || (meta.hasSourceImage === true && meta.enhanceEnabled === undefined));

export type StoredCandidateSlot =
  | { key: string; requiresUnlock?: false; nsfwLevel: number | null }
  | { key?: undefined; requiresUnlock: true; blockedReason: string; nsfwLevel: number | null };

/** The picker's slots from a panel's stored candidates. An entry with no key that isn't locked is left out. */
export function candidateSlotsFromMetadata(value: unknown): StoredCandidateSlot[] | null {
  if (!Array.isArray(value)) return null;
  const slots: StoredCandidateSlot[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry) slots.push({ key: entry, nsfwLevel: null });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const { key, requiresUnlock, blockedReason, nsfwLevel } = entry as Record<string, unknown>;
    const level = typeof nsfwLevel === 'number' ? nsfwLevel : null;
    if (requiresUnlock) {
      slots.push({
        requiresUnlock: true,
        blockedReason: typeof blockedReason === 'string' ? blockedReason : 'canUpgrade',
        nsfwLevel: level,
      });
    } else if (typeof key === 'string' && key) {
      slots.push({ key, nsfwLevel: level });
    }
  }
  return slots;
}
