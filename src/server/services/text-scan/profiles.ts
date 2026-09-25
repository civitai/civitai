import type { TextScanEntityType, TextScanProfile } from '~/server/services/text-scan/types';
import { TEXT_SCAN_FLAG } from '~/server/services/text-scan/mode';

const profiles = new Map<string, TextScanProfile>();

export function registerTextScanProfile(profile: TextScanProfile) {
  profiles.set(profile.entityType, profile);
}

export function getTextScanProfile(entityType: string) {
  return profiles.get(entityType);
}

export function isTextScanEntityType(value: string): value is TextScanEntityType {
  return Object.hasOwn(TEXT_SCAN_FLAG, value);
}
