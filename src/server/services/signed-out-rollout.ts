import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';
import type { FeatureAccess, FeatureFlagKey } from '~/server/services/feature-flags.service';
import { evaluateSignedOutFlipt } from '~/server/services/feature-flags.service';
import {
  readSignedOutRolloutBucket,
  signedOutRolloutEntity,
} from '~/shared/utils/signed-out-rollout-bucket';

/**
 * Flags that roll out to signed-out visitors per visitor bucket (`~/shared/utils/signed-out-rollout-bucket`),
 * each with the Flipt key it reads. In the registry they are dark (`availability: []`, no `fliptKey`),
 * so this is their only writer.
 */
export const SIGNED_OUT_ROLLOUT_FLAGS = {
  feedGoTransportSignedOut: 'feed-go-transport-signed-out',
  feedGoTransportSignedOutModelGetAll: 'feed-go-transport-signed-out-model-getall',
  feedGoTransportSignedOutInfinite: 'feed-go-transport-signed-out-infinite',
  clientShadowCompareSignedOut: 'client-shadow-compare-signed-out',
} as const satisfies Partial<Record<FeatureFlagKey, string>>;

export type SignedOutRolloutFlag = keyof typeof SIGNED_OUT_ROLLOUT_FLAGS;

type Evaluate = (fliptKey: string, entityId: string) => boolean | null;

/**
 * Sets the `SIGNED_OUT_ROLLOUT_FLAGS` on `flags` (in place, and returned) for one render: on exactly
 * when there is no session user, the request carries a valid bucket cookie, and Flipt answers `true`
 * for that bucket's entity. Every other case leaves each of them off, whatever `flags` held:
 *   - a session user: the signed-in cohort is the signed-in flags' alone;
 *   - no request (a render whose output may be cached and shared, which must not vary per visitor);
 *   - no bucket yet (a new visitor's first page load), or an invalid one;
 *   - Flipt not answering (`null`: absent key, not loaded, an error).
 *
 * Call it only where the result reaches one visitor's own page (a server render's page props, a
 * `private, no-store` page-data response), never for a shared or cached one.
 */
export function applySignedOutRolloutFlags(
  flags: FeatureAccess,
  { user, req }: { user?: SessionUser | null; req?: NextApiRequest | IncomingMessage | null },
  evaluate: Evaluate = evaluateSignedOutFlipt
): FeatureAccess {
  const keys = Object.keys(SIGNED_OUT_ROLLOUT_FLAGS) as SignedOutRolloutFlag[];
  // FeatureAccess is sparse: an off flag is an absent key, as `computeFeatureFlags` leaves it.
  const sparse = flags as Partial<FeatureAccess>;
  for (const key of keys) delete sparse[key];
  if (user || !req) return flags;
  const bucket = readSignedOutRolloutBucket(req.headers?.cookie);
  if (bucket === null) return flags;
  const entity = bucket >= 0 ? 'anonymous' : signedOutRolloutEntity(bucket);
  for (const key of keys) {
    if (evaluate(SIGNED_OUT_ROLLOUT_FLAGS[key], entity) === true) flags[key] = true;
  }
  return flags;
}
