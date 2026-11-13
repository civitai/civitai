import { cosmeticEventOf } from '@civitai/shared/mystery-box';
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
  title: string;
  teams: readonly string[];
  getUserTeam: (userId: number, opts?: { strict?: boolean }) => Promise<string>;
  settleBalancedTeam: (userId: number) => Promise<string | undefined>;
};

type EventItemData = { event: string; team?: unknown };

const loadEvents = () => loadRegisteredEvents() as Promise<readonly ShopEvent[]>;

export function isEventShopItemData(data: unknown): data is EventItemData {
  return !!data && typeof data === 'object' && cosmeticEventOf(data) !== undefined;
}

/** Whether a cosmetic's `data` makes it one of this event's shop items. */
export function isItemOfEvent(data: unknown, event: string) {
  return isEventShopItemData(data) && data.event === event;
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

  const team = await confirmBuyerTeam(event, userId);
  if (team !== data.team)
    throw throwBadRequestError("You can only buy this in your own team's color");
}

// Strict: a degraded lookup falls back to a computed team, which is wrong for
// anyone assigned by hand, and they would pay for a colour that isn't theirs.
// A listed buyer is placed before the check, the same way joining would place them, so a join racing
// this purchase cannot move them off the colour they are paying for.
async function confirmBuyerTeam(event: ShopEvent, userId: number) {
  const settled = async () => {
    await event.settleBalancedTeam(userId);
    return event.getUserTeam(userId, { strict: true });
  };
  return settled().catch((error) => {
    logToAxiom({
      level: 'error',
      message: 'event-shop-item: team lookup failed',
      data: { userId, event: event.name, error },
    });
    throw throwBadRequestError("We couldn't confirm your team. Please try again.");
  });
}

/**
 * The buyer's confirmed team in a registered event, for a purchase whose contents depend on it (a
 * mystery box draws only from its buyer's team). Undefined when the event has no teams. Call after
 * `assertEventShopItemPurchasable`, which refuses an event that is unregistered or not running.
 */
export async function getEventBuyerTeam(eventName: string, userId: number) {
  const events = await loadEvents().catch(() => {
    throw throwBadRequestError('This item is not available right now');
  });
  const event = events.find((e) => e.name === eventName);
  if (!event) throw throwBadRequestError('This item is not available');
  if (!event.teams.length) return undefined;
  return confirmBuyerTeam(event, userId);
}

/**
 * How a viewer sees an event's mystery boxes: whether they may buy (the event is playable for them)
 * and which team's contents to show. Null when the event is unregistered, unloadable or closed to
 * them, or their team can't be read. Read only: unlike `getEventBuyerTeam` it places no one, so the
 * purchase and the open still confirm the team they draw from.
 */
export async function getEventBoxViewer(
  eventName: string,
  viewer: { id: number; isModerator?: boolean }
) {
  const readable = await readableBoxEvent(eventName, viewer);
  if (!readable) return null;
  const { event, access } = readable;
  if (!event.teams.length) return { playable: canPlayEvent(access), team: undefined };
  const team = await event.getUserTeam(viewer.id, { strict: true }).catch(() => null);
  return team ? { playable: canPlayEvent(access), team } : null;
}

/**
 * The event's title and teams for a viewer who may read its boxes, signed in or not, and whether
 * the event is playable for them (boxes on sale can be bought). Null when the event is closed to
 * them, unregistered or unloadable.
 */
export async function getEventBoxCatalogAccess(eventName: string, viewer: EventViewer) {
  const readable = await readableBoxEvent(eventName, viewer);
  if (!readable) return null;
  return {
    title: readable.event.title,
    teams: readable.event.teams,
    playable: canPlayEvent(readable.access),
  };
}

async function readableBoxEvent(eventName: string, viewer: EventViewer) {
  const events = await loadEvents().catch(() => undefined);
  const event = events?.find((e) => e.name === eventName);
  if (!event) return null;
  const access = await getEventAccess(event, viewer).catch(() => 'closed' as const);
  return canReadEvent(access) ? { event, access } : null;
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
export function createEventShopItemVisibility({
  userId,
  isModerator,
}: {
  userId?: number;
  isModerator?: boolean;
}) {
  const now = new Date();
  const teams = new Map<string, Promise<string>>();

  return async (data: unknown) => {
    if (!isEventShopItemData(data)) return true;
    const events = await loadEvents().catch(() => undefined);
    const event = events?.find((e) => e.name === data.event);
    if (
      !event ||
      !(await isPlayableFor(event, userId ? { id: userId, isModerator } : undefined, now))
    )
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
