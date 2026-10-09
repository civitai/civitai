import { throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * Event-gated shop items: a cosmetic whose `data.event` names a registered event
 * (an entry of `events` in `~/server/events`, matched on `name`) is sold only
 * while that event runs, only for paid Buzz, and, when it carries a
 * `data.team`, only to members of that team. Team hats are the first user; the
 * rules are per event, not per cosmetic kind, so a later event reuses them.
 */

type ShopEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  teams: string[];
  getUserTeam: (userId: number) => Promise<string>;
};

type EventItemData = { event: string; team?: unknown };

export function isEventShopItemData(data: unknown): data is EventItemData {
  return (
    !!data && typeof data === 'object' && typeof (data as { event?: unknown }).event === 'string'
  );
}

// Lazy: the events module pulls in the whole event engine, which the shop only
// needs once an event item is actually in hand. One shared promise, so a page of
// items checked concurrently imports it once.
let eventsPromise: Promise<ShopEvent[]> | undefined;
function loadEvents(): Promise<ShopEvent[]> {
  eventsPromise ??= import('~/server/events').then((m) => m.events);
  return eventsPromise;
}

// "Paid Buzz only": Blue is refused, the domain currency (green or yellow) is
// accepted. Kept as one check so changing which currencies count is one line.
function eventItemPaymentAllowed(payWith: 'default' | 'blue-first' | undefined) {
  return (payWith ?? 'default') === 'default';
}

/**
 * Throws unless `userId` may buy this event item right now. Fails closed: an
 * item whose event is unregistered or not running, or whose team is not one of
 * the event's teams, is not for sale whatever its listing says.
 */
export async function assertEventShopItemPurchasable({
  userId,
  data,
  payWith,
}: {
  userId: number;
  data: EventItemData;
  payWith?: 'default' | 'blue-first';
}) {
  if (!eventItemPaymentAllowed(payWith))
    throw throwBadRequestError("This item can't be bought with Blue Buzz");

  const now = new Date();
  const event = (await loadEvents()).find((e) => e.name === data.event);
  // endDate is exclusive.
  if (!event || now < event.startDate || now >= event.endDate)
    throw throwBadRequestError('This item is not available');

  if (data.team === undefined) return;
  if (typeof data.team !== 'string' || !event.teams.includes(data.team))
    throw throwBadRequestError('This item is not available');

  const team = await event.getUserTeam(userId);
  if (team !== data.team)
    throw throwBadRequestError("You can only buy this in your own team's colour");
}

/**
 * Builds a predicate for whether a viewer sees a cosmetic in the shop. Ordinary
 * cosmetics always show. A team item shows to anonymous viewers in every team
 * (buying needs sign-in, where the purchase check applies) and to signed-in
 * viewers only for their own team. An item naming an unregistered event shows
 * to nobody.
 */
export function createEventShopItemVisibility({ userId }: { userId?: number }) {
  const teams = new Map<string, Promise<string>>();

  return async (data: unknown) => {
    if (!isEventShopItemData(data)) return true;
    const event = (await loadEvents()).find((e) => e.name === data.event);
    if (!event) return false;
    if (data.team === undefined || !userId) return true;

    let team = teams.get(event.name);
    if (!team) {
      team = event.getUserTeam(userId);
      teams.set(event.name, team);
    }
    return (await team) === data.team;
  };
}
