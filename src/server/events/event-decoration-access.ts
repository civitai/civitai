import type { EventViewer } from '~/server/events/event-access';
import { getEventAccess } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { logToAxiom } from '~/server/logging/client';
import type { EventDecorationDefinition } from '~/shared/constants/event-decoration.constants';
import {
  canWearEventDecorations,
  EVENT_DECORATION_DEFINITIONS,
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
  const visible = new Set<string>();
  const candidates = EVENT_DECORATION_DEFINITIONS.filter(
    (d) => d.entityTypes.includes(entityType) && isEventDecorationReleased(d, now)
  );
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
