/**
 * The owner's placement review queue, as one string.
 *
 * Four call sites reach this page — the user menu, the settings card's two
 * buttons, and the two pending-placement notifications — and two of those are
 * built SERVER-side, in a notification URL that no client route table checks.
 * A rename of the page or of its tab param breaks those silently, months later,
 * for the people who most need the link to work.
 *
 * Zero imports, like `sticker-placement.ts`, so the notification processors can
 * use it without pulling a component graph into the job runner.
 */

/** The tab the queue opens on. Its own constant so the string is written once. */
export const PLACEMENT_QUEUE_RECEIVED_TAB = 'received';

/** Placements waiting on the viewer's own images — the review queue. */
export const PLACEMENT_QUEUE_RECEIVED_URL = `/user/sticker-placements?tab=${PLACEMENT_QUEUE_RECEIVED_TAB}`;

/** The viewer's own outgoing placements. */
export const PLACEMENT_QUEUE_SENT_URL = '/user/sticker-placements?tab=sent';
