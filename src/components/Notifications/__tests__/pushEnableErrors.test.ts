import { describe, expect, it } from 'vitest';
import {
  classifyPushEnableError,
  describePushEnableFailure,
} from '~/components/Notifications/pushEnableErrors';
import type { PushEnableFailure } from '~/components/Notifications/pushEnableErrors';

/**
 * The failure the user actually hit: Brave ships Google push messaging disabled, so
 * `pushManager.subscribe()` rejects with this exact AbortError and the old code surfaced the raw
 * message, which names no cause and no fix.
 */
const BRAVE_PUSH_SERVICE_ERROR = Object.assign(
  new Error('Registration failed - push service error'),
  { name: 'AbortError' }
);

describe('classifyPushEnableError', () => {
  it('classifies the real Chromium/Brave push-service AbortError, carrying the browser through', () => {
    expect(classifyPushEnableError(BRAVE_PUSH_SERVICE_ERROR, { isBrave: true })).toEqual({
      kind: 'push-service-unavailable',
      isBrave: true,
    });
    expect(classifyPushEnableError(BRAVE_PUSH_SERVICE_ERROR, { isBrave: false })).toEqual({
      kind: 'push-service-unavailable',
      isBrave: false,
    });
  });

  it('classifies other `Registration failed - …` AbortErrors as push-service failures', () => {
    const err = Object.assign(new Error('Registration failed - no sender id'), {
      name: 'AbortError',
    });
    expect(classifyPushEnableError(err, { isBrave: false })).toEqual({
      kind: 'push-service-unavailable',
      isBrave: false,
    });
  });

  it('classifies a mid-flight permission revocation as a denial, not a push-service failure', () => {
    // Permission must win: its remedy (unblock the site) differs from the push-service remedy, and
    // Chromium can report a revocation with a `Registration failed - permission denied` message
    // that would otherwise match the push-service arm.
    const notAllowed = Object.assign(new Error('Subscription failed'), {
      name: 'NotAllowedError',
    });
    expect(classifyPushEnableError(notAllowed, { isBrave: true })).toEqual({
      kind: 'permission-denied',
    });

    const deniedMessage = Object.assign(new Error('Registration failed - permission denied'), {
      name: 'AbortError',
    });
    expect(classifyPushEnableError(deniedMessage, { isBrave: true })).toEqual({
      kind: 'permission-denied',
    });
  });

  it('preserves the browser wording for anything unrecognised rather than inventing a cause', () => {
    const weird = Object.assign(new Error('something else entirely'), { name: 'TypeError' });
    expect(classifyPushEnableError(weird, { isBrave: false })).toEqual({
      kind: 'unknown',
      message: 'something else entirely',
    });
  });

  it('does not throw on non-Error throwables', () => {
    expect(classifyPushEnableError(undefined, { isBrave: false })).toEqual({
      kind: 'unknown',
      message: '',
    });
    expect(classifyPushEnableError('a string', { isBrave: false })).toEqual({
      kind: 'unknown',
      message: '',
    });
  });
});

describe('describePushEnableFailure', () => {
  it('names the Brave toggle, the settings page and the restart', () => {
    const copy = describePushEnableFailure({ kind: 'push-service-unavailable', isBrave: true });
    expect(copy).toEqual({
      title: "Brave's push service is turned off",
      message:
        'Brave disables Google push messaging by default, so notifications cannot be registered. Open brave://settings/privacy, turn on "Use Google services for push messaging", restart Brave, then try again.',
      persist: true,
    });
  });

  it('gives non-Brave browsers generic push-service advice, and never mentions Brave', () => {
    const copy = describePushEnableFailure({ kind: 'push-service-unavailable', isBrave: false });
    expect(copy).toEqual({
      title: "Your browser's push service is unavailable",
      message:
        "The browser could not reach its push service, so notifications cannot be registered. Check that you are online and that push messaging is not disabled in your browser's privacy settings, then try again.",
      persist: true,
    });
    expect(copy.message).not.toMatch(/brave/i);
    expect(copy.title).not.toMatch(/brave/i);
  });

  it('the two push-service arms are genuinely different copy', () => {
    // Guards the branch itself: a mutant collapsing the ternary would return identical copy for
    // both browsers and every individual assertion above would still be checking one real string.
    const brave = describePushEnableFailure({ kind: 'push-service-unavailable', isBrave: true });
    const other = describePushEnableFailure({ kind: 'push-service-unavailable', isBrave: false });
    expect(brave).not.toEqual(other);
  });

  it('sends a denied user to site settings and says the page cannot re-ask', () => {
    expect(describePushEnableFailure({ kind: 'permission-denied' })).toEqual({
      title: 'Notifications are blocked for Civitai',
      message:
        "Your browser is blocking notifications for this site, and the page cannot ask again. Open this site's permissions (the icon just left of the address bar), set Notifications to Allow, then reload and try again.",
      persist: true,
    });
  });

  it('tells a dismissing user to click again and choose Allow', () => {
    expect(describePushEnableFailure({ kind: 'permission-dismissed' })).toEqual({
      title: 'Push notifications were not enabled',
      message:
        'Your browser did not get an answer to the notification prompt. Click "Enable push notifications" again and choose Allow.',
      persist: false,
    });
  });

  it('distinguishes a dismissal from a denial — different advice, and only one is re-askable', () => {
    const dismissed = describePushEnableFailure({ kind: 'permission-dismissed' });
    const denied = describePushEnableFailure({ kind: 'permission-denied' });
    expect(dismissed).not.toEqual(denied);
    // The denial is the one that cannot be retried from the page, so it must not say "click again".
    expect(denied.message).not.toMatch(/click .*again/i);
  });

  it('describes an incomplete subscription', () => {
    expect(describePushEnableFailure({ kind: 'subscription-incomplete' })).toEqual({
      title: 'Push notifications were not enabled',
      message:
        'Your browser returned an incomplete push subscription. Reload the page and try again — if it keeps happening, try a different browser.',
      persist: false,
    });
  });

  it('quotes an unknown error, and substitutes text when it has no message', () => {
    expect(describePushEnableFailure({ kind: 'unknown', message: 'boom' })).toEqual({
      title: 'Could not enable push notifications',
      message: 'boom',
      persist: false,
    });
    // An empty message would render a blank toast body.
    expect(describePushEnableFailure({ kind: 'unknown', message: '' }).message).toBe(
      'Your browser did not say why. Reload the page and try again.'
    );
  });

  it('every failure kind produces non-empty, actionable copy', () => {
    const all: PushEnableFailure[] = [
      { kind: 'permission-dismissed' },
      { kind: 'permission-denied' },
      { kind: 'push-service-unavailable', isBrave: true },
      { kind: 'push-service-unavailable', isBrave: false },
      { kind: 'subscription-incomplete' },
      { kind: 'unknown', message: '' },
    ];
    for (const failure of all) {
      const copy = describePushEnableFailure(failure);
      expect(copy.title.length, `title for ${failure.kind}`).toBeGreaterThan(0);
      expect(copy.message.length, `message for ${failure.kind}`).toBeGreaterThan(0);
    }
  });

  it('only the cases with instructions to follow persist', () => {
    // The point of `persist` — a 3s auto-close on "open this page and restart the browser" is
    // unreadable, while a persistent toast for "click again" is just noise.
    expect(describePushEnableFailure({ kind: 'permission-denied' }).persist).toBe(true);
    expect(
      describePushEnableFailure({ kind: 'push-service-unavailable', isBrave: true }).persist
    ).toBe(true);
    expect(describePushEnableFailure({ kind: 'permission-dismissed' }).persist).toBe(false);
    expect(describePushEnableFailure({ kind: 'unknown', message: 'x' }).persist).toBe(false);
  });
});
