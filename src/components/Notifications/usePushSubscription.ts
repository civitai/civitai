import { useCallback, useEffect } from 'react';
import {
  classifyPushEnableError,
  describePushEnableFailure,
} from '~/components/Notifications/pushEnableErrors';
import type { PushEnableFailure } from '~/components/Notifications/pushEnableErrors';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { usePushSubscriptionStore } from '~/store/push-subscription.store';
import type { PushSupport } from '~/store/push-subscription.store';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

function getPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return 'unsupported';
  // 'Notification' can be absent while PushManager exists (Firefox with web notifications
  // disabled) — reading Notification.permission there is a ReferenceError, not a denial.
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)
    return 'supported';
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  if (isIos && !isStandalone) return 'needs-standalone';
  return 'unsupported';
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

async function getSubscription() {
  const registration = await navigator.serviceWorker.register('/sw.js');
  return { registration, subscription: await registration.pushManager.getSubscription() };
}

/**
 * Brave ships Google push messaging DISABLED, which makes "push service unavailable" its default
 * state rather than a fault — so its remedy is a specific toggle worth naming. `navigator.brave` is
 * non-standard and only Brave exposes it; anything else (including a throw) means "not Brave", which
 * only ever costs us the more generic copy.
 */
async function isBraveBrowser(): Promise<boolean> {
  const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
  try {
    return (await brave?.isBrave?.()) === true;
  } catch {
    return false;
  }
}

/** Single exit point for a failed `enable()`, so no branch can go quiet again. */
function reportPushEnableFailure(failure: PushEnableFailure) {
  const { title, message, persist } = describePushEnableFailure(failure);
  showErrorNotification({
    title,
    error: { message },
    autoClose: persist ? false : 8000,
  });
}

/**
 * The single owner of the browser-side push state: permission, SW registration, and the
 * subscribe/unsubscribe round trips. Registration happens only inside `enable()` — never on page
 * load — so no SW exists for users who never opted in.
 */
export function usePushSubscription() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  // One store for the whole browser, not per-hook state: this hook is mounted independently by
  // PushDeviceToggle and PushDeviceList, and per-instance copies drift apart the moment either one
  // subscribes or revokes (see the store's own comment).
  const support = usePushSubscriptionStore((s) => s.support);
  const permission = usePushSubscriptionStore((s) => s.permission);
  const subscribed = usePushSubscriptionStore((s) => s.subscribed);
  const currentEndpoint = usePushSubscriptionStore((s) => s.currentEndpoint);
  const busy = usePushSubscriptionStore((s) => s.busy);
  const setState = usePushSubscriptionStore((s) => s.set);

  // Effect, not render-time: SSR always computes 'unsupported', so deriving during render would
  // hydrate-mismatch on any browser where push exists.
  useEffect(() => {
    setState({ support: getPushSupport() });
  }, [setState]);

  useEffect(() => {
    if (support !== 'supported' || !currentUser) return;
    setState({ permission: Notification.permission });
    // Only look for an existing registration — never create one from an effect.
    navigator.serviceWorker.getRegistration('/sw.js').then(async (registration) => {
      const subscription = await registration?.pushManager.getSubscription();
      setState({
        subscribed: !!subscription,
        currentEndpoint: subscription?.endpoint ?? null,
      });
    });
  }, [support, currentUser, setState]);

  // The server list is the truth about whether THIS browser's subscription is live. The browser
  // can hold an orphaned subscription (a subscribe call that never reached the server, a device
  // revoked from another browser) — trusting it renders an "on" toggle that delivers nothing.
  // staleTime 0 (the app-wide default is Infinity): reconciliation only works if a settings visit
  // actually re-fetches — a device revoked from another browser must read as off here.
  const { data: serverSubscriptions } = trpc.notification.getPushSubscriptions.useQuery(undefined, {
    enabled: !!currentUser && permission === 'granted' && !!currentEndpoint,
    staleTime: 0,
  });
  const serverKnowsThisDevice = currentEndpoint
    ? serverSubscriptions?.some((s) => s.endpoint === currentEndpoint)
    : undefined;

  const subscribeMutation = trpc.notification.subscribePush.useMutation({
    onSuccess: () => {
      queryUtils.notification.getPushSettings.invalidate();
      queryUtils.notification.getPushSubscriptions.invalidate();
    },
  });
  const unsubscribeMutation = trpc.notification.unsubscribePush.useMutation({
    onSuccess: () => queryUtils.notification.getPushSubscriptions.invalidate(),
  });

  /** Ask for browser permission (native prompt) and register the subscription server-side. */
  const enable = useCallback(async () => {
    if (support !== 'supported' || busy) return false;
    setState({ busy: true });
    try {
      const result = await Notification.requestPermission();
      setState({ permission: result });
      if (result !== 'granted') {
        // Previously a bare `return false`, which made the button look inert: no toast, no state
        // change, nothing on screen. A denial and a dismissal need different advice — a denial
        // cannot be re-asked from the page at all, so it has to send the user to site settings.
        reportPushEnableFailure(
          result === 'denied' ? { kind: 'permission-denied' } : { kind: 'permission-dismissed' }
        );
        return false;
      }

      const { registration } = await getSubscription();
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string),
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        // Also silent before. We have nothing to send to, so it is a failure, not a no-op.
        reportPushEnableFailure({ kind: 'subscription-incomplete' });
        return false;
      }
      await subscribeMutation.mutateAsync({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setState({ subscribed: true, currentEndpoint: json.endpoint });
      return true;
    } catch (error) {
      // `Registration failed - push service error` is the common one and is useless on its own;
      // classify it into something actionable. Brave detection is awaited only on the failure path.
      reportPushEnableFailure(classifyPushEnableError(error, { isBrave: await isBraveBrowser() }));
      return false;
    } finally {
      setState({ busy: false });
    }
  }, [support, busy, subscribeMutation, setState]);

  /** Drop this browser's subscription (server row + browser-side subscription). */
  const disable = useCallback(async () => {
    if (busy) return;
    setState({ busy: true });
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await unsubscribeMutation.mutateAsync({ endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setState({ subscribed: false, currentEndpoint: null });
    } finally {
      setState({ busy: false });
    }
  }, [busy, unsubscribeMutation, setState]);

  return {
    support,
    permission,
    /**
     * Push is live in THIS browser: permission granted, a subscription registered, and the server
     * holds its row. `serverKnowsThisDevice === false` (loaded, missing) reads as off;
     * undefined (still loading) does not flicker the toggle off.
     */
    active: permission === 'granted' && subscribed && serverKnowsThisDevice !== false,
    /** This browser's subscription endpoint — matches its PushSubscription row. */
    currentEndpoint,
    busy,
    enable,
    disable,
  };
}
