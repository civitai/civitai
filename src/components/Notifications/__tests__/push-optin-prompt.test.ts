import { describe, expect, it } from 'vitest';
import type { PushPromptState } from '~/components/Notifications/pushPrompt';
import { decidePushPrompt, isPushAskSnoozed } from '~/components/Notifications/pushPrompt';
import { EXCLUDED_ROUTE } from '~/components/Notifications/PushOptInPrompt';
import { rowsForPushTypes } from '~/components/Notifications/pushPromptRows';
import { trackActionSchema } from '~/server/schema/track.schema';

// A first-time visitor on a push-capable browser, past the arming delay: the prompt shows.
const eligible: PushPromptState = {
  signedIn: true,
  blocked: false,
  support: 'supported',
  permission: 'default',
  settingsLoaded: true,
  snoozed: false,
  shownRecently: false,
  armed: true,
  hidden: false,
  dialogOpen: false,
  routeExcluded: false,
  otherDevice: false,
};

describe('decidePushPrompt (design §1)', () => {
  it('shows the new-user prompt to an eligible visitor', () => {
    expect(decidePushPrompt(eligible)).toBe('new');
  });

  it.each<[string, Partial<PushPromptState>]>([
    ['signed out', { signedIn: false }],
    ['onboarding or banned', { blocked: true }],
    ['permission denied at the browser', { permission: 'denied' }],
    // Most often push switched off here on purpose; the settings card offers to finish it.
    ['permission already granted', { permission: 'granted' }],
    ['iOS Safari, not installed', { support: 'needs-standalone' }],
    ['push unsupported', { support: 'unsupported' }],
    ['permission not read yet', { permission: null }],
    ['settings still loading', { settingsLoaded: false }],
    ['Not now budget spent or within 90 days', { snoozed: true }],
    ['shown recently in this browser', { shownRecently: true }],
    ['before the first navigation or 20 s', { armed: false }],
    ['the tab is in the background', { hidden: true }],
    ['another dialog is open', { dialogOpen: true }],
    ['on an excluded route', { routeExcluded: true }],
    ['other-device lookup still loading', { otherDevice: undefined }],
  ])('shows nothing when %s', (_label, override) => {
    expect(decidePushPrompt({ ...eligible, ...override })).toBeNull();
  });

  it('asks to add this browser when another device is subscribed', () => {
    expect(decidePushPrompt({ ...eligible, otherDevice: true })).toBe('another-device');
  });
});

describe('EXCLUDED_ROUTE', () => {
  it.each([
    '/generate',
    '/models/create',
    '/models/[id]/edit',
    '/models/[id]/wizard',
    '/models/[id]/model-versions/[versionId]/wizard',
    '/models/train',
    '/training-studio',
    '/purchase/buzz',
    '/user/membership',
    '/user/account/[[...section]]',
    '/posts/create',
    '/comics/project/[id]/chapter',
  ])('keeps the prompt off %s', (route) => {
    expect(EXCLUDED_ROUTE.test(route)).toBe(true);
  });

  it.each([
    '/',
    '/images',
    '/models/[id]/[[...slug]]',
    '/creators',
    '/creator-program',
    '/user/[username]',
  ])('allows it on %s', (route) => {
    expect(EXCLUDED_ROUTE.test(route)).toBe(false);
  });
});

describe('isPushAskSnoozed (shared with the settings card)', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it('asks a user who never dismissed', () => {
    expect(isPushAskSnoozed(undefined, now)).toBe(false);
    expect(isPushAskSnoozed({}, now)).toBe(false);
  });

  it('waits 90 days after a Not now', () => {
    expect(
      isPushAskSnoozed({ pushPromptDismissedCount: 1, pushPromptDismissedAt: daysAgo(89) }, now)
    ).toBe(true);
    expect(
      isPushAskSnoozed({ pushPromptDismissedCount: 1, pushPromptDismissedAt: daysAgo(90) }, now)
    ).toBe(false);
  });

  it('stops for good after three', () => {
    expect(
      isPushAskSnoozed({ pushPromptDismissedCount: 3, pushPromptDismissedAt: daysAgo(400) }, now)
    ).toBe(true);
  });
});

describe('another-device rows', () => {
  it('lists only the groups the user already gets pushed', () => {
    expect(rowsForPushTypes(['tip-received', 'service-deal-paid-out']).map((r) => r.key)).toEqual([
      'tips',
      'services',
    ]);
    expect(rowsForPushTypes([])).toEqual([]);
  });
});

describe('Push_Prompt tracking', () => {
  const action = {
    type: 'Push_Prompt',
    details: { action: 'shown', surface: 'visit-prompt', variant: 'new', platform: 'desktop' },
  };

  it('accepts a funnel step from the browser', () => {
    expect(trackActionSchema.safeParse(action).success).toBe(true);
  });

  it('rejects a step or surface outside the closed set', () => {
    for (const details of [
      { ...action.details, action: 'clicked' },
      { ...action.details, surface: 'email' },
    ]) {
      expect(trackActionSchema.safeParse({ ...action, details }).success).toBe(false);
    }
  });
});
