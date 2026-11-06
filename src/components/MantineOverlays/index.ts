/**
 * Drop-in `Tooltip`, `Popover`, `Menu` and `HoverCard` for `@mantine/core`'s, with an SSR fast path
 * for CLOSED overlays behind the `ssrClosedOverlayFastPath` flag (`OverlayFastPathContext`).
 *
 * OFF (the default, and outside FeatureFlagsProvider): each one renders Mantine's component with
 * the same props. Nothing else changes.
 *
 * ON, for an overlay that mounts closed (not `opened`, `defaultOpened`, `initiallyOpened` or
 * `keepMounted`):
 *  - The server render and the hydrating render emit only the trigger, with exactly the attributes
 *    Mantine gives a closed trigger (`aria-haspopup`, `aria-expanded="false"`, `aria-controls`, the
 *    `useId` ids, `data-expanded`, merged classes). Mantine renders nothing else for a closed
 *    overlay, so the HTML is byte-identical to Mantine's.
 *  - Mantine's component mounts on the trigger's first pointer, focus, click or key event, or when
 *    a controlled `opened` turns true, and from then on it is Mantine — delays, keyboard handling,
 *    focus return and controlled `opened`/`onChange` included. The trigger is not remounted: see
 *    `./bridge.tsx`.
 *
 * Every app import of these four from `@mantine/core` goes through here; a lint rule keeps it so.
 */
export { Tooltip } from './Tooltip';
export { Popover, Menu, HoverCard } from './PopoverFamily';
export { OverlayFastPathContext } from './overlayFastPathContext';
