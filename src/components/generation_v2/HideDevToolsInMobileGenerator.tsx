import { useEffect } from 'react';

// Next's dev badge lives in the `nextjs-portal` shadow root, so page CSS can't reach it; the rule is
// added there too. The error overlay is separate and still shows.
const HIDE = '#devtools-indicator, .tsqd-parent-container { display: none !important; }';

/**
 * Development only: hides the Next.js dev badge and the React Query devtools button, which sit over
 * the mobile generator's footer, while the mobile generator is open.
 */
export function HideDevToolsInMobileGenerator() {
  useEffect(() => {
    const added: HTMLStyleElement[] = [];
    const addTo = (root: Node) => {
      const style = document.createElement('style');
      style.textContent = HIDE;
      root.appendChild(style);
      added.push(style);
    };
    addTo(document.head);

    const reachPortal = () => {
      const shadow = document.querySelector('nextjs-portal')?.shadowRoot;
      if (shadow && !added.some((style) => style.getRootNode() === shadow)) addTo(shadow);
    };
    reachPortal();
    // The portal mounts after hydration, and Next can re-mount it.
    const observer = new MutationObserver(reachPortal);
    observer.observe(document.body, { childList: true });

    return () => {
      observer.disconnect();
      added.forEach((style) => style.remove());
    };
  }, []);

  return null;
}
