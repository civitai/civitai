// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushSubscriptionStore } from '~/store/push-subscription.store';
import type * as TrpcModule from '~/utils/trpc';

/**
 * Firefox with dom.webnotifications.enabled=false exposes serviceWorker and PushManager but NO
 * `Notification` global, so `Notification.permission` is a ReferenceError, not a denial. That
 * threw inside BaseLayout and replaced every signed-in page with the error boundary (868m9uzm2,
 * 695 crashes / 21 users in the first six hours). Both browser-side readers of the global are
 * pinned here: PushRegistrationManager's early-return chain and getPushSupport in
 * usePushSubscription.
 */
const state = vi.hoisted(() => ({
  currentUser: { id: 1 } as { id: number } | null,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => state.currentUser,
}));
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'test-vapid-key' },
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
      subscribePush: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unsubscribePush: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

import { PushRegistrationManager } from '~/components/Notifications/PushRegistrationManager';
import { usePushSubscription } from '~/components/Notifications/usePushSubscription';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getRegistration = vi.fn();

function render(node: ReactElement) {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(node));
  return root;
}

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as T };
  function Probe() {
    result.current = useHook();
    return null;
  }
  const root = render(createElement(Probe));
  return { result, root };
}

function stubNotification(permission: NotificationPermission) {
  (window as { Notification?: unknown }).Notification = { permission };
}

beforeEach(() => {
  getRegistration.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration },
    configurable: true,
  });
  (window as { PushManager?: unknown }).PushManager = class {};
  delete (window as { Notification?: unknown }).Notification;
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
});

describe('PushRegistrationManager without a Notification global', () => {
  it('precondition: the environment models notification-less Firefox', () => {
    expect('serviceWorker' in navigator).toBe(true);
    expect('PushManager' in window).toBe(true);
    expect('Notification' in window).toBe(false);
  });

  it('mounts without touching the service worker', () => {
    render(createElement(PushRegistrationManager));
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it('positive control: with Notification granted, the same mount reaches the service worker', () => {
    // Proves the guard chain is what stops the no-Notification case — not a different
    // early return quietly short-circuiting the whole effect.
    stubNotification('granted');
    render(createElement(PushRegistrationManager));
    expect(getRegistration).toHaveBeenCalledWith('/sw.js');
  });
});

describe('usePushSubscription without a Notification global', () => {
  it('reports unsupported and never reads Notification.permission', () => {
    const { result } = renderHook(() => usePushSubscription());
    expect(result.current.support).toBe('unsupported');
    expect(result.current.permission).toBeNull();
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it('positive control: with Notification present the same browser is supported', () => {
    stubNotification('denied');
    const { result } = renderHook(() => usePushSubscription());
    expect(result.current.support).toBe('supported');
    expect(result.current.permission).toBe('denied');
  });
});
