/**
 * Hooks for reading the per-user gating lists from `useGenerationConfig`.
 *
 * The server resolves the operator-controlled `disabled*` / `modOnly*` /
 * `testing*` lists into a single per-user `gatedEcosystems` /
 * `gatedVersionIds` pair (folding in the `generation-testing` Flipt flag
 * and `isModerator`). The granular lists never leave the server, so these
 * hooks are thin typed wrappers — they exist so callers depend on a
 * stable name rather than reaching into `useGenerationConfig` directly.
 */

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';

/**
 * Returns ecosystem keys hidden from the generator UI for the current user.
 * Pass to `BaseModelInput`'s `excludeEcosystems` prop or any other consumer.
 */
export function useGatedEcosystems(): string[] {
  // `?? []` guards against stale React Query caches from before this field
  // existed — without it, a returning user with cached data crashes on spread.
  const { gatedEcosystems = [] } = useGenerationConfig();
  return gatedEcosystems;
}

/**
 * Returns model version IDs hidden from the generator UI for the current
 * user. Used to filter `VersionGroup.options` so gated versions don't
 * appear in graph-driven model selectors.
 */
export function useGatedVersionIds(): number[] {
  const { gatedVersionIds = [] } = useGenerationConfig();
  return gatedVersionIds;
}
