import { events } from '~/server/events';
import type { EventBannerCopy, EventPageCopy, EventPromoCopy } from '~/server/events/base.event';
import type { EventViewer, GatedEvent } from '~/server/events/event-access';
import { canPlayEvent, getEventAccess } from '~/server/events/event-access';
import { logToAxiom } from '~/server/logging/client';
import { getEventCosmetic } from '~/server/services/event.service';
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
  hasJoined = viewerHasJoined,
}: {
  viewer: EventViewer;
  now?: Date;
  eventDefs?: readonly BannerEvent[];
  getAccess?: typeof getEventAccess;
  hasJoined?: typeof viewerHasJoined;
}): Promise<NavBanner[]> {
  const entries = await Promise.all(
    eventDefs.map(async (event): Promise<NavBanner | null> => {
      if (!event.banner) return null;
      try {
        if (!canPlayEvent(await getAccess(event, viewer, now))) return null;
        const joined =
          !!event.banner.joinedCta &&
          !!viewer?.id &&
          (await joinedOrNot(hasJoined, event, { id: viewer.id, isModerator: viewer.isModerator }));
        return eventBanner(event, event.banner, joined);
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

// The home block's own test of joining: the event's team cosmetic is obtained. Cached per user and
// cleared on join (event.service.ts), so this costs one Redis read per signed-in bootstrap.
async function viewerHasJoined(event: string, user: { id: number; isModerator?: boolean }) {
  return !!(await getEventCosmetic({ event, user })).obtained;
}

// A failed read keeps the default cta rather than dropping the strip.
async function joinedOrNot(
  hasJoined: typeof viewerHasJoined,
  event: BannerEvent,
  user: { id: number; isModerator?: boolean }
) {
  try {
    return await hasJoined(event.name, user);
  } catch (e) {
    logToAxiom({
      type: 'error',
      name: 'nav-banner-joined',
      message: (e as Error).message,
      event: event.name,
    }).catch(() => undefined);
    return false;
  }
}

function eventBanner(event: BannerEvent, banner: EventBannerCopy, joined = false): NavBanner {
  return {
    id: `event:${event.name}`,
    title: banner.title ?? event.page?.headline ?? event.title,
    accent: banner.accent,
    text: banner.text,
    href: `/events/${event.name}`,
    cta: joined ? banner.joinedCta : banner.cta,
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
