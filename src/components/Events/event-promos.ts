import { IconConfetti, IconSparkles, IconTrophy } from '@tabler/icons-react';
import type {
  EventPromo,
  EventPromoIcon,
  NavBanner,
} from '~/shared/constants/nav-banner.constants';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';

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

export type EditorSurface = 'postEditor' | 'articleEditor' | 'modelEditor';

const EDITOR_CARD_PREFIX = {
  postEditor: 'post-editor',
  articleEditor: 'article-editor',
  modelEditor: 'model-editor',
} satisfies Record<EditorSurface, string>;

/** Hiding the card in one editor leaves the other's. */
export const editorCardId = (surface: EditorSurface, event: string) =>
  `${EDITOR_CARD_PREFIX[surface]}:event:${event}`;

/** The event card an editor shows: the first playable event with copy for it, unless hidden. */
export function editorPromo(promos: EventPromo[], dismissed: string[], surface: EditorSurface) {
  return promos.find(
    (promo) => promo[surface] && !dismissed.includes(editorCardId(surface, promo.event))
  );
}

/** "Put on a Party Hat", for an event whose decoration can sit on this kind of content. */
export function hatButtonLabel(event: string, entityType: CosmeticEntity = CosmeticEntity.Image) {
  const decoration = getEventDecorationDefinition(event);
  return decoration?.entityTypes.includes(entityType) ? `Put on a ${decoration.label}` : undefined;
}
