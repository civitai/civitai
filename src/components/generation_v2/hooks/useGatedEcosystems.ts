/**
 * useGatedEcosystems
 *
 * Returns the set of ecosystem keys that should be hidden from the
 * generator UI for the current user, based on the operator-controlled
 * Redis config returned by `useGenerationConfig`.
 *
 * No code changes are needed to gate a new ecosystem — operators set
 * `modOnlyEcosystems` / `disabledEcosystems` / `testingEcosystems` in the
 * `generation:ecosystem-config` Redis hash field and the change
 * propagates to every consumer through this hook.
 *
 * Mod-only and testing ecosystems are server-resolved per user:
 * `useGenerationConfig` returns `hasTestingAccess` (true for mods and
 * users who pass the `generation-testing` Flipt flag) so the client can
 * mirror the same gate without exposing the Flipt evaluation.
 */

import { useMemo } from 'react';
import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/**
 * Returns ecosystem keys that should be excluded from the generator UI
 * for the current user. Pass the result to `BaseModelInput`'s
 * `excludeEcosystems` prop (or any other consumer of ecosystem lists).
 */
export function useGatedEcosystems(): string[] {
  const config = useGenerationConfig();
  const currentUser = useCurrentUser();
  const isModerator = !!currentUser?.isModerator;
  const hasTestingAccess = config.hasTestingAccess || isModerator;

  return useMemo(() => {
    const gated = [...config.disabledEcosystems];
    if (!isModerator) gated.push(...config.modOnlyEcosystems);
    if (!hasTestingAccess) gated.push(...config.testingEcosystems);
    return gated;
  }, [
    config.disabledEcosystems,
    config.modOnlyEcosystems,
    config.testingEcosystems,
    isModerator,
    hasTestingAccess,
  ]);
}
