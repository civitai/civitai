import type { MediaQuality } from '~/client-utils/edge-url';
import { toMediaQuality } from '~/client-utils/edge-url';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export type UseMediaQualityReturn = {
  canUseLossless: boolean;
  quality: MediaQuality;
  /** The persisted value, unchanged by entitlement — the settings select still shows the choice. */
  imageFormat?: string | null;
};

/**
 * Reads ONLY `useCurrentUser`, which `useEdgeUrl` already depends on.
 *
 * Keep it that way. `useEdgeUrl` runs on every image, so whatever this imports lands in the import
 * graph of nearly every suite — and a wholesale `vi.mock` of a module this reached that named only
 * some of its exports would leave the rest unbound, making the importing test file fail to COLLECT.
 * That reports as zero tests, not as a failure. See
 * `src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts`.
 *
 * A signed-out viewer resolves to compressed, which is what we want them served.
 *
 * Entitlement is `isPaidMember`, NOT `isMember` — the latter is `tier != null`, which is true for
 * tier `'free'` and would hand lossless to everyone carrying a subscription row.
 */
export function useMediaQuality(): UseMediaQualityReturn {
  const currentUser = useCurrentUser();

  const canUseLossless = !!currentUser?.isPaidMember;
  const imageFormat = currentUser?.filePreferences?.imageFormat;

  return { canUseLossless, quality: toMediaQuality({ imageFormat, canUseLossless }), imageFormat };
}
