import { useEffect } from 'react';
import { env } from '~/env/client';
import { isProd } from '~/env/other';

/**
 * Registers /sw.js for every visitor so the offline fallback page can show. Same URL and scope as
 * the push opt-in path, so an existing registration is reused. Off outside production builds
 * (a stopped dev server should show the browser's error) unless NEXT_PUBLIC_ENABLE_SW_DEV=1. Dev
 * chunk names are not content-hashed, so with the flag on, unregister the worker in devtools after.
 */
export function OfflineFallbackRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (!isProd && env.NEXT_PUBLIC_ENABLE_SW_DEV !== '1') return;
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => null);
    };
    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
