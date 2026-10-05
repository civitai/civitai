/**
 * Why this module exists: turning push on fails in several distinct ways, and for the most common
 * one the browser's own message is `Registration failed - push service error` — which names no
 * cause, no setting and no remedy. Surfacing it verbatim tells the user only that something went
 * wrong. Worse, two of the cases below used to produce NO message at all: `enable()` returned
 * `false` when permission was dismissed or denied, so the button appeared inert.
 *
 * Each case here is something the user can act on, so the copy names the exact setting to check.
 *
 * Why a module and not inline strings: the discriminated union plus the exhaustive `switch` mean a
 * new `kind` cannot be added without copy for it (a type error), and every user-facing string sits
 * on one greppable surface. Being free of browser globals is a smaller benefit than it looks — it
 * buys `pushEnableErrors.test.ts` a node environment, and nothing else; the seam test drives the
 * hook under happy-dom either way. The caller supplies the one fact it can only learn at runtime
 * (`isBrave`) and owns actually displaying the result.
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
  /**
   * This browser holds a subscription minted under a different `applicationServerKey`, so
   * `subscribe()` refuses. Deterministic, and not recoverable from our UI — hence its own copy.
   */
  | { kind: 'stale-subscription' }
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

  // A subscription minted under a DIFFERENT applicationServerKey already exists in this browser.
  // Deterministic and permanent: every retry throws the same thing, and because the server holds no
  // row the device toggle renders unchecked, so its only action is `enable()` again. Left in
  // `unknown` this showed a raw Chromium sentence forever.
  // 🔴 THE MESSAGE ALONE DECIDES HERE — `name` is deliberately not read. Each of the two earlier
  // drafts was wrong, in opposite directions:
  //  - a bare `gcm_sender_id` message test (draft 1) also matched Chromium's CONFIG error
  //    (`missing applicationServerKey, and gcm_sender_id not found in manifest`), swallowing the
  //    misclassification the branch below was narrowed to stop.
  //  - a bare `name === 'InvalidStateError'` (draft 2) matched conditions a reload DOES fix — the
  //    spec rejects `subscribe()` with it when the service-worker registration was unregistered, and
  //    the `try` around this also spans `register`, `ready` and the tRPC mutation. That handed
  //    "retrying will not clear it" to retryable failures.
  // So the message must carry the ALREADY-EXISTS sense, and no `name` grants entry.
  // ⚠️ THIRD comment on this one branch; the previous two each described behaviour the code did not
  // have (the second opened "BOTH the name and the message must agree" while `name` went unread).
  // If you change the condition, change this sentence in the same edit.
  if (/a subscription with a different|already exists/i.test(message)) {
    return { kind: 'stale-subscription' };
  }

  // 🔴 MATCH THE PUSH SERVICE, NOT `Registration failed`. `Registration failed - …` is Chromium's
  // prefix for an unrelated FAMILY — `storage error`, `no service worker`, and
  // `missing applicationServerKey, and gcm_sender_id not found in manifest`. Matching the prefix
  // told a user their browser's push service was unavailable when the real cause was OUR
  // misconfiguration (a malformed VAPID key survives `urlBase64ToUint8Array`, and `getPushSupport`
  // only rejects a FALSY key), and additionally sent Brave users to flip an irrelevant toggle. That
  // is the same "assert a cause you have not established" defect as naming Brave's default, pointed
  // the other way — and it contradicted this module's own `unknown` principle two branches down.
  // Anything not named here falls to `unknown`, which quotes the browser instead of guessing.
  //
  // `service|server|daemon` because the three engines name the same component three ways. 🔴 PROVENANCE,
  // since these are string literals standing in for browser behaviour and nothing in this repo can
  // check them: `push service` is Chromium's observed wording (the failure that prompted this work) and
  // matches Gecko's `NetworkError: Push service unreachable.`; `push daemon` (Safari) and `push server`
  // (Chromium's network-error rendering) come from audit research, NOT from a browser we drove. If one
  // is wrong, that engine falls to `unknown` and shows its raw message — the pre-change behaviour —
  // and no test here would notice, because these tests pin the classifier's behaviour on a literal,
  // never that a browser emits it.
  //
  // KNOWN GAP, stated rather than guessed: Gecko also has `AbortError: Error retrieving push
  // subscription.`, which names none of the three and so falls to `unknown`. Which of its two shapes a
  // given failure yields is unverified, so this is "at least one common Firefox shape is uncovered",
  // not "all of them are". Uncovered degrades to the pre-change behaviour, never to a wrong cause.
  if (/push (?:service|server|daemon)/i.test(message)) {
    return { kind: 'push-service-unavailable', isBrave: opts.isBrave };
  }

  return { kind: 'unknown', message };
}

/** Map a failure to the user-facing title/message. Pure — one branch per `kind`. */
export function describePushEnableFailure(failure: PushEnableFailure): PushEnableFailureCopy {
  switch (failure.kind) {
    case 'permission-dismissed':
      // Not "click again and choose Allow": Chrome's quieter-permissions mode resolves 'default'
      // WITHOUT ever prompting, so for those users there is no Allow to choose and that advice is
      // inert. The copy covers both — a prompt that was dismissed, and a prompt that never appeared.
      return {
        title: 'Push notifications were not enabled',
        message:
          'Your browser did not allow notifications for this site. If you saw a prompt, choose Allow; if no prompt appeared, your browser may be suppressing them — allow Notifications for this site in its permissions, then try again.',
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
      // Brave is worth naming because it commonly ships Google's push service switched off, so the
      // remedy there is one specific toggle rather than a general "check your settings".
      //
      // 🔴 The copy ASSERTS NOTHING about that setting's current value, in either direction. Two
      // separate reasons, and an earlier draft satisfied only the first: (a) `isBrave` tells us which
      // BROWSER this is, never what the setting holds — the page cannot read it — so a Brave user who
      // already enabled it and then went offline reaches this same branch; (b) a sentence like
      // "Brave ships with this turned off" is a claim about Brave's DEFAULT, which goes quietly wrong
      // the day Brave changes it, with every test still green. Naming the setting and asking the
      // reader to check it is true under every combination of both.
      return failure.isBrave
        ? {
            title: 'Brave could not reach a push service',
            message:
              'In Brave, check brave://settings/privacy for "Use Google services for push messaging" — if it is off, turn it on and restart Brave. If it is already on, check that you are online and that nothing is blocking the push service.',
            persist: true,
          }
        : {
            title: "Your browser's push service is unavailable",
            message:
              "The browser could not reach its push service, so notifications cannot be registered. Check that you are online and that push messaging is not disabled in your browser's privacy settings, then try again.",
            persist: true,
          };

    case 'stale-subscription':
      // Deliberately does NOT say "reload and try again": retrying is exactly what cannot work here,
      // and telling someone to retry a deterministic failure is the class of advice this module
      // exists to stop. Clearing the site's notification permission drops the browser-side
      // subscription with it, which is the one remedy available without new UI.
      return {
        title: 'This browser has an old push registration',
        message:
          'This browser is still holding a push registration from an earlier setup, which cannot be reused. Retrying will not clear it: reset Notifications for this site in your browser permissions, reload, then turn push on again.',
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
