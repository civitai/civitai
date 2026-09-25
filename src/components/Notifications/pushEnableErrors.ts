/**
 * Why this module exists: turning push on fails in several distinct ways, and for the most common
 * one the browser's own message is `Registration failed - push service error` — which names no
 * cause, no setting and no remedy. Surfacing it verbatim tells the user only that something went
 * wrong. Worse, two of the cases below used to produce NO message at all: `enable()` returned
 * `false` when permission was dismissed or denied, so the button appeared inert.
 *
 * Each case here is something the user can act on, so the copy names the exact setting to change.
 *
 * Deliberately free of browser globals and of the notification system: the classification and the
 * copy are plain data, unit-testable in node without a DOM. The caller supplies the one fact it can
 * only learn at runtime (`isBrave`) and owns actually displaying the result.
 */

export type PushEnableFailure =
  /** The native prompt closed without a choice — re-askable, unlike a denial. */
  | { kind: 'permission-dismissed' }
  /** Blocked at the browser level. `Notification.requestPermission()` cannot re-ask. */
  | { kind: 'permission-denied' }
  /**
   * `pushManager.subscribe()` could not register with the browser's push service. The remedy is
   * browser-specific, so the browser travels with the failure rather than being re-detected later.
   */
  | { kind: 'push-service-unavailable'; isBrave: boolean }
  /** Subscribed, but the returned object lacked an endpoint or its keys — nothing to send to. */
  | { kind: 'subscription-incomplete' }
  /** Anything unrecognised: keep the browser's own words rather than inventing a cause. */
  | { kind: 'unknown'; message: string };

export type PushEnableFailureCopy = {
  title: string;
  message: string;
  /**
   * Whether the toast must stay until dismissed. Instructions have to survive long enough to be
   * followed — a 3s auto-close on "open this settings page and restart the browser" is unreadable.
   */
  persist: boolean;
};

/**
 * Classify a thrown `enable()` error. Matches on `name` and `message` because there is no
 * structured error code for any of this: Chromium reports an unreachable or disabled push service
 * as an `AbortError` whose message names the push service, and a mid-flight permission revocation
 * as `NotAllowedError`.
 *
 * Unknown shapes deliberately fall through to `unknown` with the original message preserved —
 * guessing a cause would be worse than quoting the browser.
 */
export function classifyPushEnableError(
  error: unknown,
  opts: { isBrave: boolean }
): PushEnableFailure {
  const err = error as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof err?.name === 'string' ? err.name : '';
  const message = typeof err?.message === 'string' ? err.message : '';

  // Permission first: a revocation between the grant and the subscribe also surfaces here, and its
  // remedy (unblock the site) is different from the push-service one.
  if (name === 'NotAllowedError' || /permission denied/i.test(message)) {
    return { kind: 'permission-denied' };
  }

  // `push service` catches Chromium's wording directly; the AbortError arm catches the other
  // `Registration failed - …` variants, which are all push-registration failures.
  if (
    /push service/i.test(message) ||
    (name === 'AbortError' && /registration failed/i.test(message))
  ) {
    return { kind: 'push-service-unavailable', isBrave: opts.isBrave };
  }

  return { kind: 'unknown', message };
}

/** Map a failure to the user-facing title/message. Pure — one branch per `kind`. */
export function describePushEnableFailure(failure: PushEnableFailure): PushEnableFailureCopy {
  switch (failure.kind) {
    case 'permission-dismissed':
      return {
        title: 'Push notifications were not enabled',
        message:
          'Your browser did not get an answer to the notification prompt. Click "Enable push notifications" again and choose Allow.',
        persist: false,
      };

    case 'permission-denied':
      return {
        title: 'Notifications are blocked for Civitai',
        message:
          "Your browser is blocking notifications for this site, and the page cannot ask again. Open this site's permissions (the icon just left of the address bar), set Notifications to Allow, then reload and try again.",
        persist: true,
      };

    case 'push-service-unavailable':
      // Brave is the case worth naming: it ships Google's push service switched OFF, so this is the
      // DEFAULT experience there rather than a broken install, and the fix is one specific toggle.
      return failure.isBrave
        ? {
            title: "Brave's push service is turned off",
            message:
              'Brave disables Google push messaging by default, so notifications cannot be registered. Open brave://settings/privacy, turn on "Use Google services for push messaging", restart Brave, then try again.',
            persist: true,
          }
        : {
            title: "Your browser's push service is unavailable",
            message:
              "The browser could not reach its push service, so notifications cannot be registered. Check that you are online and that push messaging is not disabled in your browser's privacy settings, then try again.",
            persist: true,
          };

    case 'subscription-incomplete':
      return {
        title: 'Push notifications were not enabled',
        message:
          'Your browser returned an incomplete push subscription. Reload the page and try again — if it keeps happening, try a different browser.',
        persist: false,
      };

    case 'unknown':
      return {
        title: 'Could not enable push notifications',
        // No invented cause. An empty message would render a blank toast, so say that plainly.
        message: failure.message || 'Your browser did not say why. Reload the page and try again.',
        persist: false,
      };
  }
}
