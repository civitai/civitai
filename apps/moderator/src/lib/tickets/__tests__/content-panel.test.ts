import { describe, expect, it } from 'vitest';
import { contentPanelFor } from '../content-panel';

const ticket = {
  view: 'support' as const,
  cfFeature: 'Content Related Issue' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

describe('contentPanelFor', () => {
  it('shows on a support ticket about a content related issue', () => {
    expect(contentPanelFor(ticket)).toBe('panel');
    expect(contentPanelFor({ ...ticket, cfFeature: '  Content Related Issue ' })).toBe('panel');
  });

  it('says only that no user is linked when there is none', () => {
    expect(contentPanelFor({ ...ticket, civitaiUserId: null })).toBe('unlinked');
  });

  it('is hidden on the moderation view and on other features', () => {
    expect(contentPanelFor({ ...ticket, view: 'moderation' })).toBe('hidden');
    expect(contentPanelFor({ ...ticket, cfFeature: 'Billing' })).toBe('hidden');
    expect(contentPanelFor({ ...ticket, cfFeature: null })).toBe('hidden');
  });
});
