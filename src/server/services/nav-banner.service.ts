import { events } from '~/server/events';
import type { EventBannerCopy, EventPageCopy, EventPromoCopy } from '~/server/events/base.event';
import type { EventViewer, GatedEvent } from '~/server/events/event-access';
import { canPlayEvent, getEventAccess } from '~/server/events/event-access';
import { logToAxiom } from '~/server/logging/client';
import { getEventCosmetic } from '~/server/services/event.service';
import type { EventCosmeticReads } from '~/server/services/event-cosmetic-reads';
import {
  EVENT_COSMETIC_READ_DEADLINE_MS,
  readEventCosmeticOnce,
} from '~/server/services/event-cosmetic-reads';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
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
  reads,
  hasJoined = (event, user) => viewerHasJoined(event, user, reads),
}: {
  viewer: EventViewer;
  now?: Date;
  eventDefs?: readonly BannerEvent[];
  getAccess?: typeof getEventAccess;
  /** The request's shared cosmetic reads (the settings bootstrap passes its own). */
  reads?: EventCosmeticReads;
  hasJoined?: (event: string, user: { id: number; isModerator?: boolean }) => Promise<boolean>;
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

// The home block's own test of joining: the event's team cosmetic is obtained. Cached per user for
// an hour and cleared on join (event.service.ts); a miss reads the database.
async function viewerHasJoined(
  event: string,
  user: { id: number; isModerator?: boolean },
  reads?: EventCosmeticReads
) {
  const cosmetic = await readEventCosmeticOnce(reads, { event, userId: user.id }, () =>
    getEventCosmetic({ event, user })
  );
  return !!cosmetic.obtained;
}

// A failed or slow read keeps the default cta rather than dropping the strip: this runs in the
// settings bootstrap, whose deadline would drop the whole strip from the first paint.
export const JOINED_READ_DEADLINE_MS = EVENT_COSMETIC_READ_DEADLINE_MS;

async function joinedOrNot(
  hasJoined: (event: string, user: { id: number; isModerator?: boolean }) => Promise<boolean>,
  event: BannerEvent,
  user: { id: number; isModerator?: boolean }
) {
  try {
    return await withTimeoutFallback(hasJoined(event.name, user), JOINED_READ_DEADLINE_MS, false);
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
