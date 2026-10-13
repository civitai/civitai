/**
 * Names shared by the custom-events writer (`block-event-ingest.service.ts`) and the owner read
 * path (`app-custom-events.service.ts`). A module of its own so the read path does not import
 * the ingest's session, rate-limit and insert dependencies.
 */

export const APP_BLOCK_EVENTS_TABLE = 'appBlockEvents';

/**
 * Stored in place of an event name the approved manifest does not declare, so the owner sees a
 * drop count while the caller-chosen name is never written. Declared names cannot collide with
 * it: they must start with a letter.
 */
export const UNDECLARED_EVENT_NAME = '__undeclared__';
