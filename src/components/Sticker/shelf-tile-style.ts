/**
 * For every shelf tile `grab` is bound to. `pan-y` lets a swipe scroll the
 * shelf; the callout and selection are off because iOS otherwise answers a
 * long press with its own image menu or magnifier and steals the pickup.
 */
export const SHELF_TILE_STYLE = {
  touchAction: 'pan-y',
  WebkitTouchCallout: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
} as const;
