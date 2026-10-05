// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushSubscriptionStore } from '~/store/push-subscription.store';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The SEAM between `enable()` and the failure copy. `pushEnableErrors.test.ts` pins the copy itself;
 * this file pins that every failing branch of `enable()` actually reaches it — including the two
 * that used to `return false` with no message at all, which is the defect that sent a real user
 * chasing an unactionable `Registration failed - push service error`.
 *
 * Verified in isolation is not verified: the mapper being correct says nothing about whether the
 * hook calls it, and a silent branch is exactly the failure a mapper-only test cannot see.
 */
const mocks = vi.hoisted(() => ({
  showErrorNotification: vi.fn(),
  subscribeMutateAsync: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
// A valid base64url string: `enable()` runs it through atob BEFORE subscribing, so an invalid key
// would throw first and every case below would report the wrong failure.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'A'.repeat(88) },
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: mocks.showErrorNotification,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      notification: {
        getPushSettings: { invalidate: vi.fn() },
        getPushSubscriptions: { invalidate: vi.fn() },
      },
    }),
    notification: {
      getPushSubscriptions: { useQuery: () => ({ data: undefined }) },
      subscribePush: { useMutation: () => ({ mutateAsync: mocks.subscribeMutateAsync }) },
      unsubscribePush: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

import { usePushSubscription } from '~/components/Notifications/usePushSubscription';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requestPermission = vi.fn();
const subscribe = vi.fn();
const getRegistration = vi.fn();
const register = vi.fn();

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  function Probe() {
    result.current = useHook();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe) as ReactElement));
  return result;
}

/** A well-formed subscription — the shape the success path and the "incomplete" case differ on. */
function goodSubscription() {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    }),
  };
}

function setBrave(isBrave: boolean) {
  if (isBrave) {
    Object.defineProperty(navigator, 'brave', {
      value: { isBrave: () => Promise.resolve(true) },
      configurable: true,
    });
  } else {
    delete (navigator as { brave?: unknown }).brave;
  }
}

/** Run `enable()` and return the single toast payload it produced, if any. */
async function runEnable() {
  const result = renderHook(() => usePushSubscription());
  let returned: boolean | undefined;
  await act(async () => {
    returned = await result.current.enable();
  });
  // 🔴 Enforced HERE, not per-test, and that placement is the point: `toast` below reads calls[0],
  // so every individual assertion is structurally blind to a SECOND toast. The single-exit-point
  // property is exactly what this PR added, and a mutant that reported each failure twice passed a
  // suite that killed fourteen others. One assertion in the shared helper covers all five branches.
  expect(mocks.showErrorNotification.mock.calls.length).toBeLessThan(2);
  return {
    returned,
    calls: mocks.showErrorNotification.mock.calls,
    toast: mocks.showErrorNotification.mock.calls[0]?.[0] as
      | { title?: string; error?: { message: string }; autoClose?: number | false }
      | undefined,
  };
}

beforeEach(() => {
  mocks.showErrorNotification.mockReset();
  mocks.subscribeMutateAsync.mockReset().mockResolvedValue(undefined);
  requestPermission.mockReset().mockResolvedValue('granted');
  subscribe.mockReset().mockResolvedValue(goodSubscription());
  getRegistration.mockReset().mockResolvedValue(undefined);
  register.mockReset().mockResolvedValue({ pushManager: { subscribe, getSubscription: vi.fn() } });

  (window as { Notification?: unknown }).Notification = {
    permission: 'default',
    requestPermission,
  };
  (window as { PushManager?: unknown }).PushManager = class {};
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register, getRegistration, ready: Promise.resolve({}) },
    configurable: true,
  });
  setBrave(false);

  usePushSubscriptionStore.setState({
    support: 'unsupported',
    permission: null,
    subscribed: false,
    currentEndpoint: null,
    busy: false,
  });
});

afterEach(() => {
  delete (window as { Notification?: unknown }).Notification;
  delete (window as { PushManager?: unknown }).PushManager;
  setBrave(false);
});

describe('enable() reports every failure it used to swallow', () => {
  it('positive control: the happy path subscribes and shows NO error toast', async () => {
    // Without this, every "a toast was shown" assertion below could be passing because the harness
    // fails somewhere generic, and every count would still look right.
    const { returned, calls } = await runEnable();
    expect(calls).toEqual([]);
    expect(returned).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeMutateAsync).toHaveBeenCalledWith({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });
  });

  it('a DISMISSED prompt now explains itself (previously a silent `return false`)', async () => {
    requestPermission.mockResolvedValue('default');
    const { returned, toast } = await runEnable();
    expect(returned).toBe(false);
    expect(toast?.title).toBe('Push notifications were not enabled');
    expect(toast?.error?.message).toMatch(/if no prompt appeared/i);
    expect(subscribe).not.toHaveBeenCalled();
    // Pins `persist` in the OTHER direction. The persist-true cases assert `autoClose === false`, so
    // without this a mutant hardcoding `autoClose: false` makes EVERY failure toast stick until
    // dismissed and no test notices — the noise half of the field this PR added.
    expect(toast?.autoClose).toBe(8000);
  });

  it('a DENIED prompt sends the user to site settings (previously a silent `return false`)', async () => {
    requestPermission.mockResolvedValue('denied');
    const { returned, toast } = await runEnable();
    expect(returned).toBe(false);
    expect(toast?.title).toBe('Notifications are blocked for Civitai');
    expect(toast?.error?.message).toMatch(/set Notifications to Allow/);
    // Instructions must not vanish after 3 seconds.
    expect(toast?.autoClose).toBe(false);
  });

  it('on Brave, the push-service AbortError names the Brave toggle and the restart', async () => {
    setBrave(true);
    subscribe.mockRejectedValue(
      Object.assign(new Error('Registration failed - push service error'), {
        name: 'AbortError',
      })
    );
    const { returned, toast } = await runEnable();
    expect(returned).toBe(false);
    expect(toast?.title).toBe('Brave could not reach a push service');
    expect(toast?.error?.message).toMatch(/brave:\/\/settings\/privacy/);
    expect(toast?.error?.message).toMatch(/Use Google services for push messaging/);
    expect(toast?.autoClose).toBe(false);
  });

  it('a Brave build whose isBrave() REJECTS still gets a message, just the generic one', async () => {
    // The consolidated helper swallows a rejection rather than letting it escape. Before the two
    // open-coded copies were merged, one of them had no rejection handling at all.
    Object.defineProperty(navigator, 'brave', {
      value: {
        isBrave: () => Promise.reject(new Error('nope')),
      },
      configurable: true,
    });
    subscribe.mockRejectedValue(
      Object.assign(new Error('Registration failed - push service error'), { name: 'AbortError' })
    );
    const { returned, toast } = await runEnable();
    expect(returned).toBe(false);
    expect(toast?.title).toBe("Your browser's push service is unavailable");
  });

  it('the SAME error on a non-Brave browser gets generic advice, never the Brave toggle', async () => {
    setBrave(false);
    subscribe.mockRejectedValue(
      Object.assign(new Error('Registration failed - push service error'), {
        name: 'AbortError',
      })
    );
    const { toast } = await runEnable();
    expect(toast?.title).toBe("Your browser's push service is unavailable");
    expect(toast?.error?.message).not.toMatch(/brave/i);
  });

  it('an incomplete subscription is reported, not silently treated as a no-op', async () => {
    subscribe.mockResolvedValue({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: undefined }),
    });
    const { returned, toast } = await runEnable();
    expect(returned).toBe(false);
    expect(toast?.title).toBe('Push notifications were not enabled');
    expect(toast?.error?.message).toMatch(/incomplete push subscription/);
    // Nothing to deliver to, so the server must not be told about it.
    expect(mocks.subscribeMutateAsync).not.toHaveBeenCalled();
  });

  it('a NEVER-SETTLING isBrave() still reports, and still releases busy', async () => {
    // 🔴 Regression test for a real stall. `finally` cannot run while its `catch` is suspended on a
    // pending await, so an isBrave() that never settles left `busy` true forever — disabling every
    // push control in the tab, with no toast — which is the inert-button defect this whole change
    // removes, reintroduced by its own fix. The helper now bounds the probe.
    //
    // The existing "busy is released" test cannot catch this: it drives the DENIED path, which
    // returns before ever awaiting isBrave(). The one branch made async is the one it does not reach.
    Object.defineProperty(navigator, 'brave', {
      // Never calls resolve or reject — the executor returns instead of capturing them, so the
      // promise is permanently pending. That is the whole fixture.
      value: { isBrave: () => new Promise<boolean>(() => undefined) },
      configurable: true,
    });
    subscribe.mockRejectedValue(
      Object.assign(new Error('No connection to push daemon'), { name: 'AbortError' })
    );
    const { returned, toast } = await runEnable();
    expect(returned).toBe(false);
    // Falls back to the generic copy — "no answer" is treated as "not Brave".
    expect(toast?.title).toBe("Your browser's push service is unavailable");
    expect(usePushSubscriptionStore.getState().busy).toBe(false);
  });

  it('a stale subscription under a different key is reported as unrecoverable', async () => {
    subscribe.mockRejectedValue(
      Object.assign(
        new Error(
          'Registration failed - A subscription with a different applicationServerKey (or gcm_sender_id) already exists'
        ),
        { name: 'InvalidStateError' }
      )
    );
    const { returned, toast } = await runEnable();
    expect(returned).toBe(false);
    expect(toast?.title).toBe('This browser has an old push registration');
    expect(toast?.error?.message).toMatch(/will not clear it/i);
    expect(toast?.autoClose).toBe(false);
  });

  it('a Chromium config error is NOT blamed on the push service', async () => {
    // Our misconfiguration must not be reported as the user's browser being at fault, and a Brave
    // user must not be sent to an irrelevant toggle. Falls to `unknown`, quoting the browser.
    setBrave(true);
    const message =
      'Registration failed - missing applicationServerKey, and gcm_sender_id not found in manifest';
    subscribe.mockRejectedValue(Object.assign(new Error(message), { name: 'AbortError' }));
    const { toast } = await runEnable();
    expect(toast?.title).toBe('Could not enable push notifications');
    expect(toast?.error?.message).toBe(message);
    expect(toast?.error?.message).not.toMatch(/brave:\/\/settings/);
  });

  it('an unrecognised error keeps the browser wording instead of inventing a cause', async () => {
    subscribe.mockRejectedValue(new Error('totally unexpected'));
    const { toast } = await runEnable();
    expect(toast?.title).toBe('Could not enable push notifications');
    expect(toast?.error?.message).toBe('totally unexpected');
  });

  it('exactly one toast per failed attempt', async () => {
    requestPermission.mockResolvedValue('denied');
    const { calls } = await runEnable();
    expect(calls).toHaveLength(1);
  });

  it('busy is released after a failure, so the button is clickable again', async () => {
    requestPermission.mockResolvedValue('denied');
    const { toast } = await runEnable();
    // `busy: false` is also what beforeEach sets, so on its own this assertion cannot separate "the
    // finally ran" from "enable() returned at its support/busy guard and never started". These two
    // are the ran-at-all control: permission was actually requested, and a toast was produced.
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(toast?.title).toBe('Notifications are blocked for Civitai');
    expect(usePushSubscriptionStore.getState().busy).toBe(false);
  });
});
