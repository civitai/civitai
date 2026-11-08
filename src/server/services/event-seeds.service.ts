import type { Session } from '~/types/session';
import { trpcViewer } from '~/server/auth/api-auth-session';
import { logToAxiom } from '~/server/logging/client';
import { getEventCosmetic, getViewerEventAccess } from '~/server/services/event.service';
import type { EventCosmeticReads } from '~/server/services/event-cosmetic-reads';
import {
  EVENT_COSMETIC_READ_DEADLINE_MS,
  readEventCosmeticOnce,
} from '~/server/services/event-cosmetic-reads';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import type { EventAccess } from '~/shared/constants/event-access.constants';
import { canWearEventDecorations } from '~/shared/constants/event-access.constants';
import {
  EVENT_DECORATION_DEFINITIONS,
  isEventDecorationReleased,
} from '~/shared/constants/event-decoration.constants';

/**
 * One event's answers to `event.getAccess` and `event.getCosmetic` for this viewer, as those
 * procedures would give them. `cosmetic` is absent when it was not read (signed out, or not
 * wearable) or the read failed: the client then fetches it as before.
 */
export type EventSeed = {
  event: string;
  access: EventAccess;
  cosmetic?: Awaited<ReturnType<typeof getEventCosmetic>>;
};

/**
 * Seeds for the two event queries every page asks once an event decoration is released: whether
 * the viewer may wear it (`usePlayableEventDecoration`) and whether they joined (the point pops).
 *
 * The viewer is the one tRPC would see (`trpcViewer`): a banned account reads as signed out and
 * gets no cosmetic, as `protectedProcedure` would refuse it. The cosmetic is read only where the
 * client would ask for it, a signed-in viewer who may wear the event's decorations.
 *
 * Depends on the session alone, never on cookies, like the nav banners: the signed-out answer is
 * the same for every signed-out viewer. Never rejects; an event whose read fails is left out.
 */
export async function getEventSeeds({
  user,
  now = new Date(),
  getAccess = getViewerEventAccess,
  getCosmetic = getEventCosmetic,
  reads,
}: {
  user: NonNullable<Session['user']> | undefined;
  now?: Date;
  /** The request's shared cosmetic reads (the settings bootstrap passes its own). */
  reads?: EventCosmeticReads;
  getAccess?: typeof getViewerEventAccess;
  getCosmetic?: typeof getEventCosmetic;
}): Promise<EventSeed[]> {
  const viewer = trpcViewer(user).user;
  const names = [
    ...new Set(
      EVENT_DECORATION_DEFINITIONS.filter((x) => isEventDecorationReleased(x, now)).map(
        (x) => x.event
      )
    ),
  ];
  const seeds = await Promise.all(
    names.map(async (event): Promise<EventSeed | null> => {
      let access: EventAccess;
      try {
        access = await getAccess({ event, viewer });
      } catch (e) {
        logSeedError(event, e);
        return null;
      }
      if (!viewer?.id || !canWearEventDecorations(access)) return { event, access };
      try {
        const user = { id: viewer.id, isModerator: viewer.isModerator };
        // The shared read underneath (one per request), capped as the nav banners cap it. On the
        // cap the seed goes without its cosmetic, never with an empty one: an absent key leaves
        // the query to the client, where a `null` would answer it as "no cosmetic".
        const cosmetic = await withTimeoutFallback<EventSeed['cosmetic'] | typeof TIMED_OUT>(
          readEventCosmeticOnce(reads, { event, userId: user.id }, () =>
            getCosmetic({ event, user })
          ),
          EVENT_COSMETIC_READ_DEADLINE_MS,
          TIMED_OUT
        );
        if (cosmetic === TIMED_OUT || cosmetic === undefined) return { event, access };
        return { event, access, cosmetic };
      } catch (e) {
        logSeedError(event, e);
        return { event, access };
      }
    })
  );
  return seeds.filter((x): x is EventSeed => !!x);
}

const TIMED_OUT = Symbol('event cosmetic read timed out');

function logSeedError(event: string, e: unknown) {
  logToAxiom({
    type: 'error',
    name: 'event-seeds',
    message: e instanceof Error ? e.message : String(e),
    event,
  }).catch(() => undefined);
}
