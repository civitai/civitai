import { useEffect, useState } from 'react';

export function useAdUnitImpressionTracked(adunit: string) {
  const [tracked, setTracked] = useState(false);

  useEffect(() => {
    const listener = ((e: CustomEvent) => {
      if (e.detail === adunit) setTimeout(() => setTracked(true), 1000);
    }) as EventListener;

    window.addEventListener('civitai-ad-impression', listener);
    return () => {
      window.removeEventListener('civitai-ad-impression', listener);
    };
  }, [adunit]);

  return tracked;
}
