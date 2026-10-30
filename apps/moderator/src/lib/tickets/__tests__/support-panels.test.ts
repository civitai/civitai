import { describe, expect, it } from 'vitest';
import { membershipPanelFor, shopPanelFor } from '../support-panels';

const base = {
  view: 'support' as const,
  cfFeature: 'Billing or Membership' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

describe('membershipPanelFor', () => {
  it('shows on a linked support Billing or Membership ticket, ignoring padding', () => {
    expect(membershipPanelFor(base)).toBe('panel');
    expect(membershipPanelFor({ ...base, cfFeature: ' Billing or Membership ' })).toBe('panel');
  });

  it('says only that no user is linked when there is none', () => {
    expect(membershipPanelFor({ ...base, civitaiUserId: null })).toBe('unlinked');
  });

  it('is hidden in the moderation view and on other features', () => {
    expect(membershipPanelFor({ ...base, view: 'moderation' })).toBe('hidden');
    expect(membershipPanelFor({ ...base, cfFeature: 'Billing' })).toBe('hidden');
    expect(membershipPanelFor({ ...base, cfFeature: null })).toBe('hidden');
  });
});

describe('shopPanelFor', () => {
  const shop = { ...base, cfFeature: 'Cosmetic Shop' as string | null };

  it('shows on a linked support Cosmetic Shop ticket, ignoring padding', () => {
    expect(shopPanelFor(shop)).toBe('panel');
    expect(shopPanelFor({ ...shop, cfFeature: ' Cosmetic Shop ' })).toBe('panel');
  });

  it('says only that no user is linked when there is none', () => {
    expect(shopPanelFor({ ...shop, civitaiUserId: null })).toBe('unlinked');
  });

  it('is hidden in the moderation view and on other features', () => {
    expect(shopPanelFor({ ...shop, view: 'moderation' })).toBe('hidden');
    expect(shopPanelFor(base)).toBe('hidden');
    expect(shopPanelFor({ ...shop, cfFeature: null })).toBe('hidden');
  });
});
