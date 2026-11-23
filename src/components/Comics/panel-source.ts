import { parseStoredCandidates } from '~/shared/utils/comic-candidates';

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
  return (
    parseStoredCandidates(value)?.map(
      (entry): StoredCandidateSlot =>
        entry.locked
          ? {
              requiresUnlock: true,
              blockedReason: entry.blockedReason ?? 'canUpgrade',
              nsfwLevel: entry.nsfwLevel,
            }
          : { key: entry.key as string, nsfwLevel: entry.nsfwLevel }
    ) ?? null
  );
}
