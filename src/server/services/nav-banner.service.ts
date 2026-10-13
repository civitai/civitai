import { events } from '~/server/events';
import type { EventBannerCopy, EventPageCopy, EventPromoCopy } from '~/server/events/base.event';
import type { EventViewer, GatedEvent } from '~/server/events/event-access';
import { canPlayEvent, getEventAccess } from '~/server/events/event-access';
import { logToAxiom } from '~/server/logging/client';
import type { EventPromo, NavBanner } from '~/shared/constants/nav-banner.constants';

type BannerEvent = GatedEvent & {
  title: string;
  page?: EventPageCopy;
  banner?: EventBannerCopy;
  promo?: EventPromoCopy;
  scoring?: unknown;
  join?: unknown;
};

/**
 * The nav announcement strips this viewer sees, highest priority first.
 *
 * An event's banner shows only while the viewer can play it, by the same access rule as its page,
 * so it can never advertise an event that reads as unknown to them.
 *
 * Depends on the session alone, never on cookies: a signed-out answer goes out with a shared cache
 * header (from both the settings bootstrap and tRPC), so it must be the same for every signed-out
 * viewer. Dismissals are filtered on the client for that reason.
 */
export async function getNavBanners({
  viewer,
  now = new Date(),
  eventDefs = events,
  getAccess = getEventAccess,
}: {
  viewer: EventViewer;
  now?: Date;
  eventDefs?: readonly BannerEvent[];
  getAccess?: typeof getEventAccess;
}): Promise<NavBanner[]> {
  const entries = await Promise.all(
    eventDefs.map(async (event): Promise<NavBanner | null> => {
      if (!event.banner) return null;
      try {
        return canPlayEvent(await getAccess(event, viewer, now))
          ? eventBanner(event, event.banner)
          : null;
      } catch (e) {
        // One event's broken gate must not take the other strips, or the page, with it.
        logToAxiom({
          type: 'error',
          name: 'nav-banner',
          message: (e as Error).message,
          event: event.name,
        }).catch(() => undefined);
        return null;
      }
    })
  );
  return entries.filter((x): x is NavBanner => !!x).sort((a, b) => b.priority - a.priority);
}

function eventBanner(event: BannerEvent, banner: EventBannerCopy): NavBanner {
  return {
    id: `event:${event.name}`,
    title: banner.title ?? event.page?.headline ?? event.title,
    accent: banner.accent,
    text: banner.text,
    href: `/events/${event.name}`,
    cta: banner.cta,
    image: banner.image ?? event.page?.heroImage,
    background: banner.background,
    dismissible: banner.dismissible ?? true,
    priority: banner.priority ?? 0,
    promo: eventPromo(event, banner),
  };
}

function eventPromo(event: BannerEvent, banner: EventBannerCopy): EventPromo {
  const { promo = {} } = event;
  const headline = event.page?.headline ?? event.title;
  const editorCard = (copy: EventPromoCopy['postEditor']) =>
    copy && {
      ...copy,
      title: copy.title ?? headline,
      image: copy.image ?? banner.image ?? event.page?.heroImage,
    };
  return {
    event: event.name,
    menuLabel: promo.menuLabel ?? event.title,
    menuIcon: promo.menuIcon ?? 'confetti',
    // The roster page refuses any event that is not both scored and joinable.
    teamHref: event.scoring && event.join ? `/events/${event.name}/team` : undefined,
    postEditor: editorCard(promo.postEditor),
    articleEditor: editorCard(promo.articleEditor),
    modelEditor: editorCard(promo.modelEditor),
    homeBlock: promo.homeBlock && {
      ...promo.homeBlock,
      title: promo.homeBlock.title ?? headline,
      body: promo.homeBlock.body ?? banner.text,
      cta: promo.homeBlock.cta ?? banner.cta,
    },
  };
}
