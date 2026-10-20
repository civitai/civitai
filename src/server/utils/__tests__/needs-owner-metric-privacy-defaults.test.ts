import { describe, expect, it } from 'vitest';
import { needsOwnerMetricPrivacyDefaults } from '~/server/utils/model-metric-privacy';

// The owner's hide/show defaults are private settings. Both model handlers serve them through this
// gate; losing either half would hand them to every viewer of the model.
describe('needsOwnerMetricPrivacyDefaults', () => {
  it('serves a moderator editing someone else’s model', () => {
    expect(needsOwnerMetricPrivacyDefaults({ id: 1, isModerator: true }, 2)).toBe(true);
  });

  it('serves nothing to the owner, whose own settings are in their session', () => {
    expect(needsOwnerMetricPrivacyDefaults({ id: 2, isModerator: true }, 2)).toBe(false);
  });

  it('serves nothing to a non-moderator or an anonymous viewer', () => {
    expect(needsOwnerMetricPrivacyDefaults({ id: 1, isModerator: false }, 2)).toBe(false);
    expect(needsOwnerMetricPrivacyDefaults(null, 2)).toBe(false);
  });
});
