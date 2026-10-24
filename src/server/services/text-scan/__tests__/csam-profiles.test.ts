import { describe, expect, it } from 'vitest';
import '~/__tests__/mocks/db.mock';

await import('~/server/services/text-scan/profiles/index');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { TEXT_SCAN_ENTITY_TYPES } = await import('~/server/services/text-scan/mode');

const CSAM_PROFILES: readonly string[] = [
  'ChatMessage',
  'Comment',
  'CommentV2',
  'UserProfile',
  'Post',
  'Model',
  'Article',
];

describe('csam profiles', () => {
  // ModelRules keeps a mode and a retired adapter for its leftover rows, but no profile.
  it.each(TEXT_SCAN_ENTITY_TYPES.filter((entityType) => entityType !== 'ModelRules'))(
    '%s asks for csam only if it is a csam profile',
    (entityType) => {
      const profile = getTextScanProfile(entityType);
      expect(profile).toBeDefined();
      expect(profile!.labels.includes('csam')).toBe(CSAM_PROFILES.includes(entityType));
    }
  );

  it('ModelRules has no profile: it is matched literally, not scanned', () => {
    expect(getTextScanProfile('ModelRules')).toBeUndefined();
  });
});
