// What each level of access to an event allows. Who has which level is the server's call
// (src/server/events/event-access.ts); these are pure so the client can apply the same rule to the
// level the server returns.

export type EventAccess = 'closed' | 'preview' | 'open' | 'ended';

/** Readable: the event page, standings and scores. */
export const canReadEvent = (access: EventAccess) => access !== 'closed';

/** Playable: join and buy. */
export const canPlayEvent = (access: EventAccess) => access === 'preview' || access === 'open';

/**
 * Wearable: place the event's decorations and see them on content. Owned hats are kept after the
 * event, so this outlasts play: they stay on content and can still be moved once it has ended, they
 * only stop scoring and stop being sold. Still behind the event's flag, so a viewer the flag is off
 * for sees none of them.
 */
export const canWearEventDecorations = (access: EventAccess) => canReadEvent(access);
