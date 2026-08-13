/**
 * useRemixOfId Hook
 *
 * Returns the source image the generator was opened from, if any. This is a
 * claim, not proof: it says the user entered through the remix entry point, and
 * nothing more. Verified derivation is resolved server-side from the images the
 * job actually consumed — see server/services/orchestrator/remix-provenance.ts.
 */

import { useRemixStore } from '~/store/remix.store';

export function useRemixOfId(): number | undefined {
  return useRemixStore((state) => state.data?.remixOfId);
}
