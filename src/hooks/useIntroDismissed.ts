import { useEffect, useState } from 'react';

/**
 * Whether the intro stored under `key` was dismissed, and a dismiss that remembers it. Starts
 * dismissed so the server render and returning visitors never flash the intro before localStorage
 * is read; a missing key, or blocked storage, shows it.
 */
export function useIntroDismissed(key: string) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(key) === '1');
    } catch {
      setDismissed(false);
    }
  }, [key]);

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(key, '1');
    } catch {}
  };

  return [dismissed, dismiss] as const;
}
