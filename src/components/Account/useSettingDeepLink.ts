import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { readSettingAnchor, resolveSettingRedirect } from '~/components/Account/setting-links';

const FIND_TIMEOUT_MS = 8000;
const HIGHLIGHT_MS = 2200;
// Panes grow as their rows load, which moves the target after the first scroll.
const RESCROLL_AT_MS = [300, 900, 1800];
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
// `scrollIntoView` would leave the target under the sticky subnav.
const SCROLL_MARGIN_TOP = '96px';

function reveal(element: HTMLElement) {
  element.style.scrollMarginTop = SCROLL_MARGIN_TOP;
  element.scrollIntoView({ block: 'start' });
}

function flash(element: HTMLElement) {
  element.animate(
    [
      { boxShadow: '0 0 0 4px var(--mantine-color-blue-5)', borderRadius: '8px' },
      { boxShadow: '0 0 0 4px transparent', borderRadius: '8px' },
    ],
    { duration: HIGHLIGHT_MS, easing: 'ease-out' }
  );
}

/** The target usually is not in the DOM yet (panes mount rows after data loads), so watch for it rather than scrolling once. */
export function useSettingDeepLink({ followToPane }: { followToPane: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;

    if (followToPane) {
      const redirect = resolveSettingRedirect(window.location);
      if (redirect) {
        router.replace(redirect);
        return;
      }
    }

    const anchor = readSettingAnchor(window.location);
    if (!anchor) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const observer = new MutationObserver(() => find());
    const stop = () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
      USER_SCROLL_EVENTS.forEach((type) => window.removeEventListener(type, stop));
    };

    function find() {
      const element = document.getElementById(anchor as string);
      if (!element) return false;
      observer.disconnect();
      reveal(element);
      flash(element);
      USER_SCROLL_EVENTS.forEach((type) => window.addEventListener(type, stop, { once: true }));
      RESCROLL_AT_MS.forEach((ms) => timers.push(setTimeout(() => reveal(element), ms)));
      timers.push(setTimeout(stop, RESCROLL_AT_MS[RESCROLL_AT_MS.length - 1] + 100));
      return true;
    }

    if (!find()) {
      observer.observe(document.body, { childList: true, subtree: true });
      timers.push(setTimeout(stop, FIND_TIMEOUT_MS));
    }
    return stop;
    // `asPath` includes query and fragment: a link to another setting from inside the page must re-run this without a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.asPath, followToPane]);
}
