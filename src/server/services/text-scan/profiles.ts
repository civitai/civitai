import type {
  TextScanEntityType,
  TextScanLabel,
  TextScanProfile,
  TextScanSubject,
} from '~/server/services/text-scan/types';
import { getTextScanCsamMode, TEXT_SCAN_ENTITY_TYPES } from '~/server/services/text-scan/mode';

const profiles = new Map<string, TextScanProfile>();

export function registerTextScanProfile(profile: TextScanProfile) {
  profiles.set(profile.entityType, profile);
}

export function getTextScanProfile(entityType: string) {
  return profiles.get(entityType);
}

export function isTextScanEntityType(value: string): value is TextScanEntityType {
  return (TEXT_SCAN_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * The labels a scan of this profile asks for: csam only while its gate is `review`, then narrowed by
 * `labelsFor` when a subject is given. Dropped before prompts and the content hash, so a closed gate
 * needs no csam prompt and leaves every hash as it was.
 */
export async function resolveTextScanProfileLabels(
  profile: Pick<TextScanProfile, 'labels' | 'labelsFor'>,
  subject?: TextScanSubject
): Promise<TextScanLabel[]> {
  const gated =
    !profile.labels.includes('csam') || (await getTextScanCsamMode()) === 'review'
      ? profile.labels
      : profile.labels.filter((label) => label !== 'csam');
  if (!subject || !profile.labelsFor) return gated;
  const kept = new Set(profile.labelsFor(subject));
  return gated.filter((label) => kept.has(label));
}
