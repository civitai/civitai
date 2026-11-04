import { createContext } from 'react';

/**
 * Whether a CLOSED Mantine overlay (Tooltip, Popover, Menu, HoverCard) imported from
 * `~/components/MantineOverlays` renders through the fast path: the server render and the first
 * client render emit only the trigger, and Mantine's floating machinery mounts on the first
 * pointer, focus, click or key event on that trigger (or when a controlled `opened` turns true).
 *
 * Its own context, written by `FeatureFlagsProvider` from the `ssrClosedOverlayFastPath` flag, so
 * the server render and the hydrating render read the same serialised value — a server-only switch
 * could not work here, because the client must hydrate the same tree the server rendered. Every
 * overlay reads it once, at mount, so a flag that changes later never swaps an overlay's tree under
 * it. It lives outside `FeatureFlagsProvider` so the wrappers never import that module: a test that
 * mocks the provider module, or renders without it, simply gets the default, `false`, which is
 * Mantine's own behaviour.
 */
export const OverlayFastPathContext = createContext(false);
