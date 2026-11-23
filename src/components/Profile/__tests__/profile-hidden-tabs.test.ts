import { describe, expect, it } from 'vitest';
import { applyHiddenProfileTabs } from '~/components/Profile/profile-hidden-tabs';

const tabs = {
  '[username]': { disabled: false },
  models: { disabled: false },
  images: { disabled: false },
  shop: { disabled: false },
};
const visibleKeys = (result: Record<string, { disabled?: boolean }>) =>
  Object.entries(result)
    .filter(([, tab]) => !tab.disabled)
    .map(([key]) => key);

describe('applyHiddenProfileTabs', () => {
  it('drops a hidden tab from a visitor’s nav and keeps the rest', () => {
    const result = applyHiddenProfileTabs(tabs, {
      hiddenTabs: ['models'],
      viewerSeesAll: false,
      enabled: true,
    });
    expect(visibleKeys(result)).toEqual(['[username]', 'images', 'shop']);
  });

  it('shows the owner (or a moderator) every tab', () => {
    const result = applyHiddenProfileTabs(tabs, {
      hiddenTabs: ['models', 'images'],
      viewerSeesAll: true,
      enabled: true,
    });
    expect(visibleKeys(result)).toEqual(Object.keys(tabs));
  });

  it('never hides Overview or Shop, even when the stored list names them', () => {
    const result = applyHiddenProfileTabs(tabs, {
      hiddenTabs: ['[username]', 'shop', 'images'],
      viewerSeesAll: false,
      enabled: true,
    });
    expect(visibleKeys(result)).toEqual(['[username]', 'models', 'shop']);
  });

  it('hides nothing with the flag off', () => {
    const result = applyHiddenProfileTabs(tabs, {
      hiddenTabs: ['models', 'images'],
      viewerSeesAll: false,
      enabled: false,
    });
    expect(visibleKeys(result)).toEqual(Object.keys(tabs));
  });

  it('keeps a tab disabled for another reason disabled', () => {
    const result = applyHiddenProfileTabs(
      { ...tabs, models: { disabled: true } },
      { hiddenTabs: ['images'], viewerSeesAll: false, enabled: true }
    );
    expect(visibleKeys(result)).toEqual(['[username]', 'shop']);
  });
});
