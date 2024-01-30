import { useEffect, useRef, useState } from 'react';

/** Returns boolean value representing load state of script */
export function useScript({
  src,
  content,
  canLoad = true,
  onLoad,
}: {
  src?: string;
  content?: string;
  canLoad?: boolean;
  onLoad?: () => void;
}) {
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!readyRef.current && canLoad) {
      readyRef.current = true;

      const script = document.createElement('script');
      script.type = 'text/javascript';
      if (src) {
        script.src = src;
        script.onload = () => {
          setReady(true);
          onLoad?.();
        };
      }
      if (content) {
        script.innerText = content;
        setReady(true);
      }
      document.body.appendChild(script);
    }
  }, [src, content, canLoad]);

  return ready;
}
