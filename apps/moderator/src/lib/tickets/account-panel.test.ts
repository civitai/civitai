import { describe, expect, it } from 'vitest';
import { accountPanelFor } from './account-panel';

const base = {
  view: 'moderation' as const,
  cfFeature: 'Account Restriction or Banned Account' as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

describe('accountPanelFor', () => {
  it('shows the panel for a linked account-restriction ticket in the moderation view', () => {
    expect(accountPanelFor(base)).toBe('panel');
  });

  it('shows it for any moderation ticket whose router topic is account-related', () => {
    expect(
      accountPanelFor({ ...base, cfFeature: 'Moderation Decision', routerTopic: 'account-issue' })
    ).toBe('panel');
    expect(accountPanelFor({ ...base, cfFeature: null, routerTopic: 'account-issue' })).toBe(
      'panel'
    );
  });

  it('says only that no account is linked when the ticket qualifies but has no user', () => {
    expect(accountPanelFor({ ...base, civitaiUserId: null })).toBe('unlinked');
  });

  it('shows nothing for other moderation tickets, even with a linked user', () => {
    expect(accountPanelFor({ ...base, cfFeature: 'Moderation Decision' })).toBe('hidden');
    expect(accountPanelFor({ ...base, cfFeature: null, routerTopic: 'nsfw-moderation' })).toBe(
      'hidden'
    );
    expect(
      accountPanelFor({ ...base, cfFeature: 'Moderation Decision', civitaiUserId: null })
    ).toBe('hidden');
  });

  it('shows nothing in the support view', () => {
    expect(accountPanelFor({ ...base, view: 'support' })).toBe('hidden');
    expect(accountPanelFor({ ...base, view: 'support', civitaiUserId: null })).toBe('hidden');
  });
});
