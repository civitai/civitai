import type { MediaQuality } from '~/client-utils/edge-url';
import { toMediaQuality } from '~/client-utils/edge-url';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export type UseMediaQualityReturn = {
  canUseLossless: boolean;
  quality: MediaQuality;
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
 * Entitlement is `isPaidMember`, NOT `isMember` — the latter is `tier != null`, which is true for
 * tier `'free'` and would hand lossless to everyone carrying a subscription row.
 */
export function useMediaQuality(): UseMediaQualityReturn {
  const currentUser = useCurrentUser();

  const canUseLossless = !!currentUser?.isPaidMember;
  const imageFormat = currentUser?.filePreferences?.imageFormat;

  return { canUseLossless, quality: toMediaQuality({ imageFormat, canUseLossless }) };
}

/**
 * The `optimized` flag for a call site that builds its URL with raw `getEdgeUrl` rather than
 * `useEdgeUrl`. Undefined rather than `false` for lossless: `getEdgeUrl` emits any value that is not
 * undefined, and `optimized=false` is a URL shape no other surface produces — a second cache key for
 * bytes that already exist under the first.
 */
export function useOptimizedFlag(): true | undefined {
  return useMediaQuality().quality !== 'lossless' || undefined;
}
