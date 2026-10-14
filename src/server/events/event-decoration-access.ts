import type { EventViewer } from '~/server/events/event-access';
import { canWearEventDecorations, getEventAccess } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { logToAxiom } from '~/server/logging/client';
import type { EventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import {
  EVENT_DECORATION_DEFINITIONS,
  isEventDecorationData,
  isEventDecorationReleased,
} from '~/shared/constants/event-decoration.constants';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';

// Lazy: the hot feed paths reach here, and before a decoration is released nothing below the date
// check runs, so the engine stays off their import graph until then.
async function findEvent(name: string) {
  return (await loadEvents()).find((e) => e.name === name);
}

/** Whether this viewer may place, and see, this event's decorations now, during or after it. */
export async function isEventDecorationWearable(
  definition: EventDecorationDefinition,
  viewer: EventViewer,
  now = new Date()
) {
  if (!isEventDecorationReleased(definition, now)) return false;
  const event = await findEvent(definition.event);
  return !!event && canWearEventDecorations(await getEventAccess(event, viewer, now));
}

/**
 * The events whose decorations this viewer sees on this entity type now. Fails closed: if the
 * engine cannot be loaded or asked, no decorations render rather than the feed failing.
 */
export async function getVisibleDecorationEvents(
  entityType: CosmeticEntity,
  viewer: EventViewer,
  now = new Date()
) {
  return visibleAmong(
    EVENT_DECORATION_DEFINITIONS.filter((d) => d.entityTypes.includes(entityType)),
    viewer,
    now
  );
}

/**
 * A user's cosmetics, less the event decorations this viewer does not see yet: the holdings a
 * profile lists include hats nobody may see before launch. Fails closed with the same rule.
 */
export async function withoutHiddenEventDecorations<T extends { cosmetic: { data: unknown } }>(
  cosmetics: T[],
  viewer: EventViewer,
  now = new Date()
) {
  const events = new Set(
    cosmetics.flatMap(({ cosmetic }) =>
      isEventDecorationData(cosmetic.data) ? [cosmetic.data.event] : []
    )
  );
  if (!events.size) return cosmetics;
  const visible = await visibleAmong(
    EVENT_DECORATION_DEFINITIONS.filter((d) => events.has(d.event)),
    viewer,
    now
  );
  return cosmetics.filter(
    ({ cosmetic }) => !isEventDecorationData(cosmetic.data) || visible.has(cosmetic.data.event)
  );
}

async function visibleAmong(
  definitions: readonly EventDecorationDefinition[],
  viewer: EventViewer,
  now: Date
) {
  const visible = new Set<string>();
  const candidates = definitions.filter((d) => isEventDecorationReleased(d, now));
  for (const definition of candidates) {
    try {
      if (await isEventDecorationWearable(definition, viewer, now)) visible.add(definition.event);
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'event-decoration-access',
        message: (error as Error).message,
        event: definition.event,
      }).catch(() => undefined);
    }
  }
  return visible;
}
