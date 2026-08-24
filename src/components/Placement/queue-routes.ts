/**
 * The creator's own placement queues, as routes and as surface names.
 *
 * One page (`/user/placements`) holds both surfaces now; the surface is a query
 * param so a link can open either. Everything that points at a queue reaches it
 * through here — the user menu, the settings card's buttons, and the pending
 * notifications, two of which are built SERVER-side in a URL no client route
 * table checks. A rename that missed those would break silently, months later,
 * for the people who most need the link to work.
 *
 * Zero imports, like `sticker-placement.ts`, so the notification processors can
 * use it without pulling a component graph into the job runner.
 */

export const PLACEMENT_SURFACE_TABS = [
  { value: 'sticker', label: 'Stickers' },
  { value: 'remix', label: 'Remixes' },
] as const;

export type PlacementSurfaceTab = (typeof PLACEMENT_SURFACE_TABS)[number]['value'];

export function isPlacementSurfaceTab(value: unknown): value is PlacementSurfaceTab {
  return PLACEMENT_SURFACE_TABS.some((option) => option.value === value);
}

/** The unified queue page. Opens on stickers, received. */
export const PLACEMENT_QUEUE_URL = '/user/placements';

/** One surface of it, for a link that knows which queue it means. */
export function placementQueueUrl(surface: PlacementSurfaceTab, tab?: 'received' | 'sent') {
  const params = new URLSearchParams({ type: surface });
  if (tab) params.set('tab', tab);
  return `${PLACEMENT_QUEUE_URL}?${params.toString()}`;
}

/** Stickers waiting on the viewer's own images — what a pending notification means. */
export const STICKER_QUEUE_RECEIVED_URL = '/user/placements?type=sticker&tab=received';

/** The viewer's own outgoing sticker placements. */
export const STICKER_QUEUE_SENT_URL = '/user/placements?type=sticker&tab=sent';

/** Remixes waiting on the viewer's own images. */
export const REMIX_QUEUE_RECEIVED_URL = '/user/placements?type=remix&tab=received';

/** The viewer's own outgoing remix submissions. */
export const REMIX_QUEUE_SENT_URL = '/user/placements?type=remix&tab=sent';

/**
 * Turns the reveal on for whoever follows the link.
 *
 * Placed stickers are hidden by default site-wide and the count chip is the only
 * control that shows them — so every link that exists BECAUSE of a sticker lands
 * on an image that looks untouched, and the person has no way to tell that from
 * the sticker having been removed. That is the queue's "view image" link, and
 * the placer's "your sticker was accepted" notification.
 */
export const STICKER_REVEAL_PARAM = 'stickers';

const STICKER_REVEAL_VALUE = '1';

/** An image, with its placed stickers shown on arrival. */
export function imageWithStickersUrl(imageId: number) {
  return `/images/${imageId}?${STICKER_REVEAL_PARAM}=${STICKER_REVEAL_VALUE}`;
}

/**
 * Whether a router query value is asking for the reveal.
 *
 * Beside the writer above rather than at the reading end, so the two cannot
 * drift into a link that carries a value nothing recognises — which fails as a
 * page that simply does not reveal, indistinguishable from the bug this exists
 * to fix.
 */
export function stickerRevealRequested(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value[0] : value) === STICKER_REVEAL_VALUE;
}
