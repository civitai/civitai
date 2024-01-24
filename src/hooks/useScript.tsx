import { useEffect, useRef, useState } from 'react';

/** Returns boolean value representing load state of script */
export function useScript(src: string, options?: { canLoad?: boolean }) {
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const { canLoad = true } = options ?? {};

  useEffect(() => {
    if (!readyRef.current && canLoad) {
      readyRef.current = true;

      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = src;
      script.onload = () => {
        setReady(true);
      };
      document.body.appendChild(script);
    }
  }, [src, canLoad]);

  return ready;
}
