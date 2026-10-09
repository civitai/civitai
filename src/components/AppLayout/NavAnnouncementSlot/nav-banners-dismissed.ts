import { setCookie } from 'cookies-next';
import { create } from 'zustand';
import { useMaybeAppContext } from '~/providers/AppProvider';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import {
  addNavBannerDismissed,
  NAV_BANNERS_DISMISSED_COOKIE,
} from '~/shared/constants/nav-banner.constants';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// The nav slot shows at most this many event strips. With the Buzz Bonus notice above them that
// keeps the slot to two strips, and the Buzz Bonus (which loads on the client) can never change how
// many event strips render, so it cannot reflow them.
export const MAX_EVENT_STRIPS = 1;

/** The event strips to render: not dismissed, highest priority first, capped. */
export function visibleNavBanners(banners: NavBanner[], dismissed: string[]): NavBanner[] {
  const hidden = new Set(dismissed);
  return banners.filter((x) => !(x.dismissible && hidden.has(x.id))).slice(0, MAX_EVENT_STRIPS);
}

// Null until the viewer dismisses something in this tab; until then the server's reading of the
// cookie (from `_app`) is the answer, so the server render and the first client paint agree. Only
// ever written in the browser, so the server's module-scope copy stays null for every request.
const useDismissedStore = create<{ dismissed: string[] | null }>(() => ({ dismissed: null }));

export function useNavBannersDismissed() {
  const seeded = useMaybeAppContext()?.navBannersDismissed;
  const local = useDismissedStore((s) => s.dismissed);
  const dismissed = local ?? seeded ?? [];

  const dismiss = (id: string) => {
    const next = addNavBannerDismissed(useDismissedStore.getState().dismissed ?? dismissed, id);
    useDismissedStore.setState({ dismissed: next });
    setCookie(NAV_BANNERS_DISMISSED_COOKIE, JSON.stringify(next), {
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'lax',
    });
  };

  return { dismissed, dismiss };
}
