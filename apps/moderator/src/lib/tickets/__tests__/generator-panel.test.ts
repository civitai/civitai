import { describe, expect, it } from 'vitest';
import { generatorPanelFor } from '../generator-panel';
import { contentPanelFor } from '../content-panel';

const ticket = {
  view: 'support' as const,
  cfFeature: 'Image Generator' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

describe('generatorPanelFor', () => {
  it('shows on a support ticket about the image generator', () => {
    expect(generatorPanelFor(ticket)).toBe('panel');
    expect(generatorPanelFor({ ...ticket, cfFeature: '  Image Generator ' })).toBe('panel');
  });

  it('says only that no user is linked when there is none', () => {
    expect(generatorPanelFor({ ...ticket, civitaiUserId: null })).toBe('unlinked');
  });

  it('is hidden on the moderation view and on other features', () => {
    expect(generatorPanelFor({ ...ticket, view: 'moderation' })).toBe('hidden');
    expect(generatorPanelFor({ ...ticket, cfFeature: 'Billing' })).toBe('hidden');
    expect(generatorPanelFor({ ...ticket, cfFeature: null })).toBe('hidden');
  });

  it('leaves the content related issue tickets to the content panel', () => {
    const content = { ...ticket, cfFeature: 'Content Related Issue' };
    expect(generatorPanelFor(content)).toBe('hidden');
    expect(contentPanelFor(ticket)).toBe('hidden');
  });
});
