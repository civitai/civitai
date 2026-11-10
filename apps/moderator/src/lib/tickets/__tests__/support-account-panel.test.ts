import { describe, expect, it } from 'vitest';
import { supportAccountPanelFor } from '../support-account-panel';
import { accountPanelFor } from '../account-panel';
import { ACCOUNT_LOGIN_FEATURE, EMAIL_CHANGE_FEATURE } from '../routing';

const base = {
  view: 'support' as const,
  cfFeature: ACCOUNT_LOGIN_FEATURE as string | null,
  routerTopic: null as string | null,
  civitaiUserId: 7 as number | null,
};

describe('supportAccountPanelFor', () => {
  it.each([ACCOUNT_LOGIN_FEATURE, EMAIL_CHANGE_FEATURE, ` ${EMAIL_CHANGE_FEATURE} `])(
    'shows the panel on a linked support ticket whose feature is %j',
    (cfFeature) => {
      expect(supportAccountPanelFor({ ...base, cfFeature })).toBe('panel');
    }
  );

  it('says no user is linked rather than showing a panel', () => {
    expect(supportAccountPanelFor({ ...base, civitaiUserId: null })).toBe('unlinked');
  });

  it('is hidden in the moderation view', () => {
    expect(supportAccountPanelFor({ ...base, view: 'moderation' })).toBe('hidden');
  });

  it('is hidden for other features and for a featureless ticket, even an account-issue topic', () => {
    expect(supportAccountPanelFor({ ...base, cfFeature: 'Billing' })).toBe('hidden');
    expect(supportAccountPanelFor({ ...base, cfFeature: null, routerTopic: 'account-issue' })).toBe(
      'hidden'
    );
  });

  it('leaves the write-side account predicate hiding every support ticket', () => {
    expect(accountPanelFor(base)).toBe('hidden');
    expect(accountPanelFor({ ...base, cfFeature: EMAIL_CHANGE_FEATURE })).toBe('hidden');
  });
});
