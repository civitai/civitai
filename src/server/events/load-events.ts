import type { events as Events } from '~/server/events';
import { logToAxiom } from '~/server/logging/client';

/**
 * The registered events, loaded lazily to keep the event engine (ClickHouse, Discord, user service)
 * off the import graph of hot paths (the shop, the feeds) until an event is actually in hand. One
 * shared promise, cleared on failure so a bad load is retried rather than kept.
 */
let eventsPromise: Promise<typeof Events> | undefined;
export function loadEvents(): Promise<typeof Events> {
  eventsPromise ??= import('~/server/events')
    .then((m) => m.events)
    .catch((error) => {
      eventsPromise = undefined;
      logToAxiom({ level: 'error', message: 'events: lazy load failed', data: { error } });
      throw error;
    });
  return eventsPromise;
}
