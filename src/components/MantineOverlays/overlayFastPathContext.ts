import { createContext } from 'react';

/**
 * Whether closed overlays from `~/components/MantineOverlays` take the fast path (see `./index.ts`).
 *
 * Its own context, written by `FeatureFlagsProvider` from the `ssrClosedOverlayFastPath` flag, so
 * the server render and the hydrating render read the same serialised value. It lives outside
 * `FeatureFlagsProvider` so the wrappers never import that module: a test that mocks the provider,
 * or renders without it, gets the default `false` (Mantine's own behaviour).
 */
export const OverlayFastPathContext = createContext(false);
