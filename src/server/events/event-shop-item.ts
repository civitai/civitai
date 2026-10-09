import type { EventViewer, GatedEvent } from '~/server/events/event-access';
import { canPlayEvent, canReadEvent, getEventAccess } from '~/server/events/event-access';
import { loadEvents as loadRegisteredEvents } from '~/server/events/load-events';
import { logToAxiom } from '~/server/logging/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * Event-gated shop items: a cosmetic whose `data.event` names a registered event
 * (an entry of `events` in `~/server/events`, matched on `name`) is sold only
 * while that event is playable for the buyer (its window, its flag and preview:
 * see event-access.ts), only for paid Buzz, and, when it carries a
 * `data.team`, only to members of that team. Team hats are the first user; the
 * rules are per event, not per cosmetic kind, so a later event reuses them.
 */

type ShopEvent = GatedEvent & {
  teams: readonly string[];
  getUserTeam: (userId: number, opts?: { strict?: boolean }) => Promise<string>;
};

type EventItemData = { event: string; team?: unknown };

const loadEvents = () => loadRegisteredEvents() as Promise<readonly ShopEvent[]>;

export function isEventShopItemData(data: unknown): data is EventItemData {
  return (
    !!data && typeof data === 'object' && typeof (data as { event?: unknown }).event === 'string'
  );
}

const isPlayableFor = async (event: ShopEvent, viewer: EventViewer, now: Date) =>
  canPlayEvent(await getEventAccess(event, viewer, now));

// "Paid Buzz only": Blue is refused, the domain currency (green or yellow) is
// accepted. Kept as one check so changing which currencies count is one line.
function eventItemPaymentAllowed(payWith: 'default' | 'blue-first' | undefined) {
  return (payWith ?? 'default') === 'default';
}

/**
 * Throws unless `userId` may buy this event item right now. Fails closed: an
 * item whose event is unregistered, unloadable or not running, whose team is
 * not one of the event's teams, or whose buyer's team can't be confirmed, is
 * not for sale whatever its listing says.
 */
export async function assertEventShopItemPurchasable({
  userId,
  isModerator,
  data,
  payWith,
  resumingClaim = false,
}: {
  userId: number;
  isModerator?: boolean;
  data: EventItemData;
  payWith?: 'default' | 'blue-first';
  /**
   * A retry of a purchase whose claim was charged. The event's window is a sale
   * window like the listing's own, and was checked when the claim was made, so
   * an event that has since ended still sells it; the flag (the kill switch),
   * the team and payment rules still apply.
   */
  resumingClaim?: boolean;
}) {
  if (!eventItemPaymentAllowed(payWith))
    throw throwBadRequestError("This item can't be bought with Blue Buzz");

  const events = await loadEvents().catch(() => {
    throw throwBadRequestError('This item is not available right now');
  });
  const event = events.find((e) => e.name === data.event);
  const access = event && (await getEventAccess(event, { id: userId, isModerator }, new Date()));
  if (!access || !(resumingClaim ? canReadEvent(access) : canPlayEvent(access)))
    throw throwBadRequestError('This item is not available');

  if (data.team === undefined) return;
  if (typeof data.team !== 'string' || !event.teams.includes(data.team))
    throw throwBadRequestError('This item is not available');

  // Strict: a degraded lookup falls back to a computed team, which is wrong for
  // anyone assigned by hand, and they would pay for a colour that isn't theirs.
  const team = await event.getUserTeam(userId, { strict: true }).catch((error) => {
    logToAxiom({
      level: 'error',
      message: 'event-shop-item: team lookup failed',
      data: { userId, event: event.name, error },
    });
    throw throwBadRequestError("We couldn't confirm your team. Please try again.");
  });
  if (team !== data.team)
    throw throwBadRequestError("You can only buy this in your own team's colour");
}

/**
 * Builds a predicate for whether a viewer sees a cosmetic in the shop. Ordinary
 * cosmetics always show. An event item shows only while its event is playable
 * for the viewer: to anonymous viewers in every team (buying needs sign-in,
 * where the purchase check applies) and to signed-in viewers only for their own
 * team. If the
 * events can't be loaded, event items are hidden and the rest of the shop still
 * renders.
 */
export function createEventShopItemVisibility({ userId }: { userId?: number }) {
  const now = new Date();
  const teams = new Map<string, Promise<string>>();

  return async (data: unknown) => {
    if (!isEventShopItemData(data)) return true;
    const events = await loadEvents().catch(() => undefined);
    const event = events?.find((e) => e.name === data.event);
    if (!event || !(await isPlayableFor(event, userId ? { id: userId } : undefined, now)))
      return false;
    if (data.team === undefined || !userId) return true;

    let team = teams.get(event.name);
    if (!team) {
      team = event.getUserTeam(userId);
      teams.set(event.name, team);
    }
    return (await team) === data.team;
  };
}
