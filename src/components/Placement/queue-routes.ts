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
