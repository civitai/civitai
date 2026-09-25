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

  it('matches real non-Chromium push-service wordings across engines', () => {
    // Real strings, not constructed: Safari says "push daemon", Gecko says "Push service
    // unreachable." under a NetworkError. Matching the push service by NAME rather than by
    // Chromium's `Registration failed` prefix is what makes these land in the right branch.
    const engineErrors = [
      Object.assign(new Error('No connection to push daemon'), { name: 'AbortError' }),
      Object.assign(new Error('Push service unreachable.'), { name: 'NetworkError' }),
    ];
    for (const err of engineErrors) {
      expect(classifyPushEnableError(err, { isBrave: false }), err.message).toEqual({
        kind: 'push-service-unavailable',
        isBrave: false,
      });
    }
  });

  it('🔴 does NOT blame the push service for Chromium `Registration failed - …` CONFIG errors', () => {
    // This test previously asserted the OPPOSITE, and pinning that was the defect. `Registration
    // failed - …` is Chromium's prefix for an unrelated family, so matching the prefix told users
    // their browser's push service was unavailable — and sent Brave users to flip an irrelevant
    // toggle — when the real cause was our own misconfiguration. These must fall to `unknown`, which
    // quotes the browser rather than naming a cause we have not established.
    const ourFault = [
      'Registration failed - missing applicationServerKey, and gcm_sender_id not found in manifest',
      'Registration failed - storage error',
      'Registration failed - no service worker',
    ];
    for (const message of ourFault) {
      const err = Object.assign(new Error(message), { name: 'AbortError' });
      expect(classifyPushEnableError(err, { isBrave: true }), message).toEqual({
        kind: 'unknown',
        message,
      });
    }
  });

  it('classifies an existing subscription under a different key as a stale subscription', () => {
    // Real Chromium wording. Deterministic and unrecoverable by retrying, so it must not land in
    // `unknown` (whose copy invites a retry) nor in push-service (whose remedy is unrelated).
    const err = Object.assign(
      new Error(
        'Registration failed - A subscription with a different applicationServerKey (or gcm_sender_id) already exists'
      ),
      { name: 'InvalidStateError' }
    );
    expect(classifyPushEnableError(err, { isBrave: false })).toEqual({
      kind: 'stale-subscription',
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
      title: 'Brave could not reach a push service',
      message:
        'In Brave, check brave://settings/privacy for "Use Google services for push messaging" — if it is off, turn it on and restart Brave. If it is already on, check that you are online and that nothing is blocking the push service.',
      persist: true,
    });
  });

  it("asserts nothing about the setting's value, in EITHER direction", () => {
    // 🔴 This guard replaces one that was mutation-proved vacuous: it forbade the words a previous
    // draft happened to use (`disables`, `cannot be registered`), so a mutant asserting the same
    // thing in different words — "Google push messaging is switched off in your Brave" — passed it.
    // Forbidding WORDS is walkable by rewording, so this pins the SHAPE instead: every mention of
    // the setting's state must be conditional. The page cannot read that setting, and a claim about
    // Brave's default goes wrong the day Brave changes it.
    const { message } = describePushEnableFailure({
      kind: 'push-service-unavailable',
      isBrave: true,
    });
    // Both branches are present, so no single state is being asserted.
    expect(message).toMatch(/if it is off/i);
    expect(message).toMatch(/if it is already on/i);
    // And no sentence declares a state outright. These patterns are about GRAMMAR, not vocabulary:
    // "<subject> is/ships/comes ... off/disabled/turned off" with no conditional governing it.
    const assertsState =
      /\b(?:ships?|comes?|is|are|has|have)\b[^.]{0,40}\b(?:turned off|switched off|disabled|off by default)\b/i;
    const sentences = message.split(/(?<=\.)\s+/);
    const offenders = sentences.filter((s) => assertsState.test(s) && !/\bif\b/i.test(s));
    expect(offenders).toEqual([]);
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

  it('covers BOTH a dismissed prompt and a prompt that never appeared', () => {
    // Chrome's quieter-permissions mode resolves 'default' without ever prompting, so advice that
    // only says "choose Allow" is inert for those users — there was nothing to choose.
    const copy = describePushEnableFailure({ kind: 'permission-dismissed' });
    expect(copy).toEqual({
      title: 'Push notifications were not enabled',
      message:
        'Your browser did not allow notifications for this site. If you saw a prompt, choose Allow; if no prompt appeared, your browser may be suppressing them — allow Notifications for this site in its permissions, then try again.',
      persist: false,
    });
    expect(copy.message).toMatch(/if no prompt appeared/i);
  });

  it('tells a stale-subscription user that retrying will NOT help', () => {
    // The one deterministic, permanently-unrecoverable failure. Advice to retry would be actively
    // wrong here, which is why it does not share the `unknown` copy.
    const copy = describePushEnableFailure({ kind: 'stale-subscription' });
    expect(copy).toEqual({
      title: 'This browser has an old push registration',
      message:
        'This browser is still holding a push registration from an earlier setup, which cannot be reused. Retrying will not clear it: reset Notifications for this site in your browser permissions, reload, then turn push on again.',
      persist: true,
    });
    expect(copy.message).toMatch(/will not clear it/i);
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
      { kind: 'stale-subscription' },
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
