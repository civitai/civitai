import { useEffect } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '~/env/client';

/**
 * Keeps the service worker file fresh for users who already opted in — update() on the existing
 * registration is how a new sw.js ships to existing subscribers. Deliberately does NOT create
 * first-time state: no permission ask, no registration unless one already exists (see
 * usePushSubscription.enable for that).
 */
export function PushRegistrationManager() {
  const currentUser = useCurrentUser();

  useEffect(() => {
    if (
      !currentUser ||
      !env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      Notification.permission !== 'granted'
    )
      return;
    navigator.serviceWorker.getRegistration('/sw.js').then((registration) => {
      if (registration) registration.update().catch(() => null);
    });
  }, [currentUser]);

  return null;
}
