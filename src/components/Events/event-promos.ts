import { IconConfetti, IconSparkles, IconTrophy } from '@tabler/icons-react';
import type {
  EventPromo,
  EventPromoIcon,
  NavBanner,
} from '~/shared/constants/nav-banner.constants';

// The user menu lists at most this many events; the strip shows only the first.
export const MAX_EVENT_MENU_ENTRIES = 2;

const PROMO_ICONS = {
  confetti: IconConfetti,
  trophy: IconTrophy,
  sparkles: IconSparkles,
} satisfies Record<EventPromoIcon, unknown>;

/**
 * The promos of the events this viewer can play. Read from the unfiltered banner answer, never from
 * the visible strips: dismissing a strip must not take the event's other entry points with it.
 */
export function eventPromosFrom(banners: NavBanner[] | undefined): EventPromo[] {
  return (banners ?? []).flatMap((banner) => (banner.promo ? [banner.promo] : []));
}

export function eventMenuEntries(promos: EventPromo[]) {
  return promos.slice(0, MAX_EVENT_MENU_ENTRIES).map((promo) => ({
    event: promo.event,
    label: promo.menuLabel,
    icon: PROMO_ICONS[promo.menuIcon] ?? IconConfetti,
    href: `/events/${promo.event}`,
  }));
}

export function teamRosterHref(promos: EventPromo[], event: string) {
  return promos.find((promo) => promo.event === event)?.teamHref;
}

/** Said once, when the strip goes: where the event now lives, if the menu lists it. */
export function dismissHint(banner: NavBanner, banners: NavBanner[]) {
  const listed = eventMenuEntries(eventPromosFrom(banners)).some(
    (entry) => entry.event === banner.promo?.event
  );
  return listed && banner.promo
    ? `Find ${banner.promo.menuLabel} in your menu any time.`
    : undefined;
}
